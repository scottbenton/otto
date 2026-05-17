import { hydrateContext } from "../context/hydrate.js";
import { normalizeContext } from "../context/normalize.js";
import type { GitHubClient } from "../github/client.js";
import { createPrForIssueTask } from "../github/pulls.js";
import type { OttoLogger } from "../logger.js";
import { claimOrAbort, commentSourceKey } from "../polling/claim.js";
import type { DispatchBatch } from "../polling/dispatch.js";
import {
  completedStatus,
  failedStatus,
  updateStatusComment,
} from "../polling/status.js";
import type { TriggerMatch } from "../polling/trigger.js";
import { NonFastForwardError, type RepoManager } from "../repo/manager.js";
import type { AgentRunner } from "../runner/types.js";

export type ExecuteRunDeps = {
  github: GitHubClient;
  machineId: string;
  repoManager: RepoManager;
  agentRunner: AgentRunner;
  timeoutMs: number;
  onRunComplete: (targetKey: string) => void;
  logger: OttoLogger;
};

function deriveBranch(targetKey: string, runId: string): string {
  const safe = targetKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `otto/${safe}-${runId.slice(0, 8)}`;
}

export async function executeRun(
  batch: DispatchBatch<TriggerMatch>,
  deps: ExecuteRunDeps,
): Promise<void> {
  const { github, machineId, repoManager, agentRunner, timeoutMs, onRunComplete, logger } = deps;

  const trigger = batch.items[batch.items.length - 1];
  if (trigger === undefined) {
    onRunComplete(batch.targetKey);
    return;
  }

  const { comment, repo, taskDescription } = trigger;
  const runLog = logger.child({ targetKey: batch.targetKey, repo });

  const claim = await claimOrAbort(github, comment, machineId);
  if (!claim.claimed) {
    runLog.info({}, "run skipped — already claimed");
    onRunComplete(batch.targetKey);
    return;
  }

  const { runId, statusCommentId } = claim;
  const identity = { runId, machineId, sourceKey: commentSourceKey(comment) };

  runLog.info({ runId }, "run claimed");

  let worktreeAcquired = false;
  try {
    const rawCtx = await hydrateContext(github, comment);
    const ctx = normalizeContext(rawCtx);

    const branch = deriveBranch(batch.targetKey, runId);
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
      await updateStatusComment(
        github,
        comment,
        statusCommentId,
        identity,
        failedStatus(reason, result.summary),
      );
      runLog.warn({ runId, error: result.error }, "agent run failed");
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

    await updateStatusComment(
      github,
      comment,
      statusCommentId,
      identity,
      completedStatus(
        pullRequestUrl !== undefined ? { branchUrl, pullRequestUrl } : { branchUrl },
      ),
    );

    runLog.info({ runId, branchUrl, pullRequestUrl }, "run completed");
  } catch (err) {
    const reason: "push-failed" | "unknown" =
      err instanceof NonFastForwardError ? "push-failed" : "unknown";
    const errMsg = err instanceof Error ? err.message : String(err);
    runLog.error({ runId, error: errMsg }, "run failed");
    try {
      await updateStatusComment(
        github,
        comment,
        statusCommentId,
        identity,
        failedStatus(reason, errMsg),
      );
    } catch {
      // best-effort
    }
  } finally {
    if (worktreeAcquired) {
      await repoManager.releaseWorktree(batch.targetKey).catch(() => undefined);
    }
    onRunComplete(batch.targetKey);
  }
}
