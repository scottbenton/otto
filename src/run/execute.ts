import { randomUUID } from "node:crypto";

import { hydrateContext } from "../context/hydrate.js";
import { normalizeContext } from "../context/normalize.js";
import type { GitHubClient } from "../github/client.js";
import { createPrForIssueTask } from "../github/pulls.js";
import type { OttoLogger } from "../logger.js";
import { claimOrAbort, commentSourceKey } from "../polling/claim.js";
import type { DispatchBatch } from "../polling/dispatch.js";
import { completedStatus, failedStatus, updateStatusComment } from "../polling/status.js";
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
  taskDescription: string;
  statusCommentId: number;
  identity: { runId: string; machineId: string; sourceKey: string };
};

function deriveBranch(targetKey: string, batchRunId: string): string {
  const safe = targetKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `otto/${safe}-${batchRunId.slice(0, 8)}`;
}

function buildTaskDescription(claims: ClaimEntry[]): string {
  if (claims.length === 1) return claims[0]?.taskDescription ?? "";
  return claims.map((c, i) => `${String(i + 1)}. ${c.taskDescription}`).join("\n\n");
}

async function updateAllClaims(
  github: GitHubClient,
  claims: ClaimEntry[],
  result: AgentRunResult,
  branchUrl: string,
  pullRequestUrl: string | undefined
): Promise<void> {
  await Promise.allSettled(
    claims.map(({ comment, statusCommentId, identity }) => {
      const summary =
        result.commentSummaries?.[comment.id] ??
        (result.summary.length > 0 ? result.summary : undefined);
      const opts: Parameters<typeof completedStatus>[0] = { branchUrl };
      if (pullRequestUrl !== undefined) opts.pullRequestUrl = pullRequestUrl;
      if (summary !== undefined) opts.summary = summary;
      return updateStatusComment(github, comment, statusCommentId, identity, completedStatus(opts));
    })
  );
}

async function failAllClaims(
  github: GitHubClient,
  claims: ClaimEntry[],
  reason: "runner-failed" | "timeout" | "push-failed" | "unknown",
  summary?: string
): Promise<void> {
  await Promise.allSettled(
    claims.map(({ comment, statusCommentId, identity }) =>
      updateStatusComment(github, comment, statusCommentId, identity, failedStatus(reason, summary))
    )
  );
}

export async function executeRun(
  batch: DispatchBatch<TriggerMatch>,
  deps: ExecuteRunDeps
): Promise<void> {
  const { github, machineId, repoManager, agentRunner, timeoutMs, onRunComplete, logger } = deps;

  const firstItem = batch.items[0];
  if (firstItem === undefined) {
    onRunComplete(batch.targetKey);
    return;
  }

  const { repo } = firstItem;
  const batchRunId = randomUUID();
  const runLog = logger.child({ targetKey: batch.targetKey, repo, batchRunId });

  // Attempt to claim each trigger comment. Skip any already owned by another instance.
  const claims: ClaimEntry[] = [];
  let lastClaim: ClaimEntry | undefined;
  for (const item of batch.items) {
    const claim = await claimOrAbort(github, item.comment, machineId);
    if (!claim.claimed) continue;
    lastClaim = {
      comment: item.comment,
      taskDescription: item.taskDescription,
      statusCommentId: claim.statusCommentId,
      identity: { runId: claim.runId, machineId, sourceKey: commentSourceKey(item.comment) }
    };
    claims.push(lastClaim);
  }

  if (lastClaim === undefined) {
    runLog.info({}, "run skipped — all comments already claimed");
    onRunComplete(batch.targetKey);
    return;
  }

  runLog.info({ claimCount: claims.length }, "run claimed");

  let worktreeAcquired = false;
  try {
    const rawCtx = await hydrateContext(
      github,
      claims.map((c) => c.comment)
    );
    const ctx = normalizeContext(rawCtx);

    const taskDescription = buildTaskDescription(claims);
    const branch = ctx.pullRequest?.headBranch ?? deriveBranch(batch.targetKey, batchRunId);

    const worktree = await repoManager.prepareWorktree({
      slug: repo,
      targetKey: batch.targetKey,
      branch,
      ...(ctx.pullRequest !== null ? { baseBranch: ctx.pullRequest.headBranch } : {})
    });
    worktreeAcquired = true;

    const result = await agentRunner.run({
      task: taskDescription,
      context: ctx,
      repoPaths: [worktree.path],
      capabilityGrants: agentRunner.capabilities,
      timeoutMs
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
      branch: worktree.branch
    });
    const branchUrl = `https://github.com/${repo}/tree/${pushed.branch}`;

    let pullRequestUrl: string | undefined;
    if (ctx.sourceType === "issue_comment") {
      const prInput: Parameters<typeof createPrForIssueTask>[1] = {
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: ctx.number,
        issueTitle: ctx.issue.title,
        branch: pushed.branch
      };
      if (result.prBody !== undefined) {
        prInput.agentPrBody = result.prBody;
      }
      const pr = await createPrForIssueTask(github, prInput);
      pullRequestUrl = pr.htmlUrl;
    } else if (ctx.pullRequest !== null) {
      pullRequestUrl = ctx.pullRequest.htmlUrl;
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
