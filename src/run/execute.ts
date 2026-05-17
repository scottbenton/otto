import { randomUUID } from "node:crypto";

import { hydrateContext } from "../context/hydrate.js";
import { normalizeContext } from "../context/normalize.js";
import type { GitHubClient } from "../github/client.js";
import { createPrForIssueTask } from "../github/pulls.js";
import type { OttoLogger } from "../logger.js";
import { claimOrAbort, commentSourceKey } from "../polling/claim.js";
import type { DispatchBatch } from "../polling/dispatch.js";
import {
  abortedDuplicateClaimStatus,
  completedStatus,
  failedStatus,
  updateStatusComment,
} from "../polling/status.js";
import type { TriggerMatch } from "../polling/trigger.js";
import type { RawComment } from "../polling/types.js";
import { NonFastForwardError, type RepoManager } from "../repo/manager.js";
import type { AgentRunResult, AgentRunner } from "../runner/types.js";

export type ExecuteRunDeps = {
  github: GitHubClient;
  machineId: string;
  repoManager: RepoManager;
  agentRunner: AgentRunner;
  timeoutMs: number;
  onRunComplete: (targetKey: string) => void;
  logger: OttoLogger;
};

type ClaimEntry = {
  comment: RawComment;
  statusCommentId: number;
  identity: { runId: string; machineId: string; sourceKey: string };
};

function deriveBranch(targetKey: string, batchRunId: string): string {
  const safe = targetKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `otto/${safe}-${batchRunId.slice(0, 8)}`;
}

function buildTaskDescription(items: TriggerMatch[]): string {
  if (items.length === 1) {
    const first = items[0];
    return first !== undefined ? first.taskDescription : "";
  }
  return items.map((item, i) => `${String(i + 1)}. ${item.taskDescription}`).join("\n\n");
}

async function rollbackClaims(
  github: GitHubClient,
  claims: ClaimEntry[],
): Promise<void> {
  await Promise.allSettled(
    claims.map(({ comment, statusCommentId, identity }) =>
      updateStatusComment(github, comment, statusCommentId, identity, abortedDuplicateClaimStatus()),
    ),
  );
}

async function updateAllClaims(
  github: GitHubClient,
  claims: ClaimEntry[],
  result: AgentRunResult,
  branchUrl: string,
  pullRequestUrl: string | undefined,
): Promise<void> {
  await Promise.allSettled(
    claims.map(({ comment, statusCommentId, identity }) => {
      const perCommentSummary = result.commentSummaries?.[comment.id];
      const opts: Parameters<typeof completedStatus>[0] = { branchUrl };
      if (pullRequestUrl !== undefined) opts.pullRequestUrl = pullRequestUrl;
      if (perCommentSummary !== undefined) opts.summary = perCommentSummary;
      return updateStatusComment(
        github,
        comment,
        statusCommentId,
        identity,
        completedStatus(opts),
      );
    }),
  );
}

async function failAllClaims(
  github: GitHubClient,
  claims: ClaimEntry[],
  reason: "runner-failed" | "timeout" | "push-failed" | "unknown",
  summary?: string,
): Promise<void> {
  await Promise.allSettled(
    claims.map(({ comment, statusCommentId, identity }) =>
      updateStatusComment(github, comment, statusCommentId, identity, failedStatus(reason, summary)),
    ),
  );
}

export async function executeRun(
  batch: DispatchBatch<TriggerMatch>,
  deps: ExecuteRunDeps,
): Promise<void> {
  const { github, machineId, repoManager, agentRunner, timeoutMs, onRunComplete, logger } = deps;

  const lastTrigger = batch.items[batch.items.length - 1];
  if (lastTrigger === undefined) {
    onRunComplete(batch.targetKey);
    return;
  }

  const { repo } = lastTrigger;
  const batchRunId = randomUUID();
  const runLog = logger.child({ targetKey: batch.targetKey, repo, batchRunId });

  // Claim every trigger comment. If any claim fails, roll back previous claims and bail —
  // another instance already owns this batch.
  const claims: ClaimEntry[] = [];
  for (const item of batch.items) {
    const claim = await claimOrAbort(github, item.comment, machineId);
    if (!claim.claimed) {
      await rollbackClaims(github, claims);
      runLog.info({}, "run skipped — already claimed");
      onRunComplete(batch.targetKey);
      return;
    }
    claims.push({
      comment: item.comment,
      statusCommentId: claim.statusCommentId,
      identity: { runId: claim.runId, machineId, sourceKey: commentSourceKey(item.comment) },
    });
  }

  runLog.info({ claimCount: claims.length }, "run claimed");

  let worktreeAcquired = false;
  try {
    // Hydrate context from the most recent trigger comment.
    const rawCtx = await hydrateContext(github, lastTrigger.comment);
    const ctx = normalizeContext(rawCtx);

    const taskDescription = buildTaskDescription(batch.items);
    const branch = deriveBranch(batch.targetKey, batchRunId);

    const worktree = await repoManager.prepareWorktree({
      slug: repo,
      targetKey: batch.targetKey,
      branch,
    });
    worktreeAcquired = true;

    const result = await agentRunner.run({
      task: taskDescription,
      context: ctx,
      repoPaths: [worktree.path],
      capabilityGrants: agentRunner.capabilities,
      timeoutMs,
    });

    if (!result.success) {
      const reason: "timeout" | "runner-failed" =
        result.error?.includes("timed out") === true ? "timeout" : "runner-failed";
      await failAllClaims(github, claims, reason, result.summary);
      runLog.warn({ error: result.error }, "agent run failed");
      return;
    }

    const pushed = await repoManager.pushBranch({
      repoPath: worktree.repoPath,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    const branchUrl = `https://github.com/${repo}/tree/${pushed.branch}`;

    let pullRequestUrl: string | undefined;
    if (ctx.sourceType === "issue_comment") {
      const pr = await createPrForIssueTask(github, {
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: ctx.number,
        issueTitle: ctx.issue.title,
        branch: pushed.branch,
      });
      pullRequestUrl = pr.htmlUrl;
    }

    await updateAllClaims(github, claims, result, branchUrl, pullRequestUrl);

    runLog.info({ branchUrl, pullRequestUrl }, "run completed");
  } catch (err) {
    const reason: "push-failed" | "unknown" =
      err instanceof NonFastForwardError ? "push-failed" : "unknown";
    const errMsg = err instanceof Error ? err.message : String(err);
    runLog.error({ error: errMsg }, "run failed");
    await failAllClaims(github, claims, reason, errMsg);
  } finally {
    if (worktreeAcquired) {
      await repoManager.releaseWorktree(batch.targetKey).catch(() => undefined);
    }
    onRunComplete(batch.targetKey);
  }
}
