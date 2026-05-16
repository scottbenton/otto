import type { GitHubClient } from "../github/client.js";
import type { IssueComment, RawComment } from "./types.js";

function isIssueComment(comment: RawComment): comment is IssueComment {
  return "issue_url" in comment;
}

export function commentSourceKey(comment: RawComment): string {
  if (isIssueComment(comment)) {
    return `issue_comment:${String(comment.id)}`;
  }
  return `pr_review_comment:${String(comment.id)}`;
}

function threadCommentsUrl(comment: RawComment): string {
  if (isIssueComment(comment)) {
    return `${comment.issue_url}/comments`;
  }
  return `${comment.pull_request_url}/comments`;
}

function createCommentUrl(comment: RawComment): string {
  if (isIssueComment(comment)) {
    return `${comment.issue_url}/comments`;
  }
  return `${comment.pull_request_url}/comments/${String(comment.id)}/replies`;
}

function repoBase(comment: RawComment): string {
  if (isIssueComment(comment)) {
    return comment.issue_url.replace(/\/issues\/\d+$/, "");
  }
  return comment.pull_request_url.replace(/\/pulls\/\d+$/, "");
}

function updateCommentUrl(comment: RawComment, statusCommentId: number): string {
  const base = repoBase(comment);
  if (isIssueComment(comment)) {
    return `${base}/issues/comments/${String(statusCommentId)}`;
  }
  return `${base}/pulls/comments/${String(statusCommentId)}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bodyHasClaimFor(body: string, sourceKey: string): boolean {
  if (!/<!--[\s\S]*?otto:v1\s+status\b/.test(body)) return false;
  return new RegExp(`\\bsource=${escapeRegex(sourceKey)}\\b`).test(body);
}

const COMMENT_FOOTER = "\n\n---\n[🤖 Otto](https://github.com/scottbenton/otto)";

function buildStatusBody(runId: string, machineId: string, sourceKey: string): string {
  return `<!-- otto:v1 status run=${runId} machine=${machineId} source=${sourceKey} -->\n**[Otto]** Status: running${COMMENT_FOOTER}`;
}

function buildAbortBody(runId: string, machineId: string, sourceKey: string): string {
  return `<!-- otto:v1 status run=${runId} machine=${machineId} source=${sourceKey} -->\n**[Otto]** Status: aborted (duplicate claim)${COMMENT_FOOTER}`;
}

type StatusCommentEntry = { id: number; created_at: string };

async function findStatusComments(
  client: GitHubClient,
  trigger: RawComment,
  sourceKey: string,
): Promise<StatusCommentEntry[]> {
  const comments = await client.paginateAll<{ id: number; body: string; created_at: string }>(
    threadCommentsUrl(trigger),
  );
  return comments.filter((c) => bodyHasClaimFor(c.body, sourceKey));
}

export type ClaimResult =
  | { claimed: true; runId: string; statusCommentId: number }
  | { claimed: false };

export async function isAlreadyClaimed(
  client: GitHubClient,
  comment: RawComment,
): Promise<boolean> {
  const sourceKey = commentSourceKey(comment);
  const url = threadCommentsUrl(comment);
  const comments = await client.paginateAll<{ body: string }>(url);
  return comments.some((c) => bodyHasClaimFor(c.body, sourceKey));
}

export async function claimOrAbort(
  client: GitHubClient,
  trigger: RawComment,
  machineId: string,
): Promise<ClaimResult> {
  if (await isAlreadyClaimed(client, trigger)) {
    return { claimed: false };
  }

  const runId = crypto.randomUUID();
  const sourceKey = commentSourceKey(trigger);
  const statusBody = buildStatusBody(runId, machineId, sourceKey);

  const created = await client.request<{ id: number; created_at: string }>(
    createCommentUrl(trigger),
    { method: "POST", body: { body: statusBody } },
  );

  const allClaims = await findStatusComments(client, trigger, sourceKey);

  if (allClaims.length <= 1) {
    return { claimed: true, runId, statusCommentId: created.id };
  }

  const winner = allClaims.reduce((a, b) =>
    new Date(a.created_at) <= new Date(b.created_at) ? a : b,
  );

  if (winner.id === created.id) {
    return { claimed: true, runId, statusCommentId: created.id };
  }

  await client.request(updateCommentUrl(trigger, created.id), {
    method: "PATCH",
    body: { body: buildAbortBody(runId, machineId, sourceKey) },
  });

  return { claimed: false };
}
