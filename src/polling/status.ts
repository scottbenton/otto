import type { GitHubClient } from "../github/client.js";
import { buildComment } from "./format.js";
import type { IssueComment, RawComment } from "./types.js";

type StatusIdentity = {
  runId: string;
  machineId: string;
  sourceKey: string;
};

export type CompletedStatusOptions = {
  branchUrl: string;
  pullRequestUrl?: string;
};

export type FailedStatusReason = "runner-failed" | "timeout" | "push-failed" | "unknown";

export type StatusTransition =
  | { status: "running" }
  | { status: "completed"; branchUrl: string; pullRequestUrl?: string }
  | { status: "failed"; reason?: FailedStatusReason; summary?: string }
  | { status: "interrupted" }
  | { status: "aborted"; reason: "duplicate-claim" };

function isIssueComment(comment: RawComment): comment is IssueComment {
  return "issue_url" in comment;
}

function repoBase(comment: RawComment): string {
  if (isIssueComment(comment)) {
    return comment.issue_url.replace(/\/issues\/\d+$/, "");
  }
  return comment.pull_request_url.replace(/\/pulls\/\d+$/, "");
}

export function statusCommentUrl(trigger: RawComment, statusCommentId: number): string {
  const base = repoBase(trigger);
  if (isIssueComment(trigger)) {
    return `${base}/issues/comments/${String(statusCommentId)}`;
  }
  return `${base}/pulls/comments/${String(statusCommentId)}`;
}

export function buildStatusComment(identity: StatusIdentity, transition: StatusTransition): string {
  return buildComment(
    identity.runId,
    identity.machineId,
    identity.sourceKey,
    statusContent(transition),
  );
}

export async function updateStatusComment(
  client: GitHubClient,
  trigger: RawComment,
  statusCommentId: number,
  identity: StatusIdentity,
  transition: StatusTransition,
): Promise<void> {
  await client.request(statusCommentUrl(trigger, statusCommentId), {
    method: "PATCH",
    body: { body: buildStatusComment(identity, transition) },
  });
}

export function completedStatus(options: CompletedStatusOptions): StatusTransition {
  const transition: StatusTransition = {
    status: "completed",
    branchUrl: options.branchUrl,
  };
  if (options.pullRequestUrl !== undefined) {
    transition.pullRequestUrl = options.pullRequestUrl;
  }
  return transition;
}

export function failedStatus(
  reason: FailedStatusReason = "unknown",
  summary?: string,
): StatusTransition {
  return { status: "failed", reason, ...(summary !== undefined ? { summary } : {}) };
}

export function interruptedStatus(): StatusTransition {
  return { status: "interrupted" };
}

export function abortedDuplicateClaimStatus(): StatusTransition {
  return { status: "aborted", reason: "duplicate-claim" };
}

function statusContent(transition: StatusTransition): string {
  switch (transition.status) {
    case "running":
      return "Status: running";
    case "completed":
      return completedContent(transition);
    case "failed":
      return failedContent(transition);
    case "interrupted":
      return "Status: interrupted - daemon restarted. Remove this comment and re-trigger to retry.";
    case "aborted":
      return "Status: aborted (duplicate claim)";
  }
}

const SUMMARY_MAX_LENGTH = 500;
const RETRY_INSTRUCTION = "To retry, post a new comment: otto retry";

function completedContent(transition: Extract<StatusTransition, { status: "completed" }>): string {
  const lines = ["Status: completed", "", `Branch: ${transition.branchUrl}`];
  if (transition.pullRequestUrl !== undefined) {
    lines.push(`Pull request: ${transition.pullRequestUrl}`);
  }
  return lines.join("\n");
}

function failedContent(transition: Extract<StatusTransition, { status: "failed" }>): string {
  const detail = failureDetail(transition.reason ?? "unknown");
  const lines = ["Status: failed", "", detail];

  if (transition.summary !== undefined && transition.summary.length > 0) {
    const truncated =
      transition.summary.length > SUMMARY_MAX_LENGTH
        ? `${transition.summary.slice(0, SUMMARY_MAX_LENGTH)}…`
        : transition.summary;
    lines.push("", truncated);
  }

  lines.push("", RETRY_INSTRUCTION);
  return lines.join("\n");
}

function failureDetail(reason: FailedStatusReason): string {
  switch (reason) {
    case "runner-failed":
      return "The agent command did not complete successfully.";
    case "timeout":
      return "The agent command timed out.";
    case "push-failed":
      return "Git push failed. Otto never force-pushes; pull/rebase locally and retry.";
    case "unknown":
      return "Otto could not complete the run.";
  }
}
