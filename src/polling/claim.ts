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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bodyHasClaimFor(body: string, sourceKey: string): boolean {
  if (!/<!--[\s\S]*?otto:v1\s+status\b/.test(body)) return false;
  return new RegExp(`\\bsource=${escapeRegex(sourceKey)}\\b`).test(body);
}

export async function isAlreadyClaimed(
  client: GitHubClient,
  comment: RawComment,
): Promise<boolean> {
  const sourceKey = commentSourceKey(comment);
  const url = threadCommentsUrl(comment);
  const comments = await client.paginateAll<{ body: string }>(url);
  return comments.some((c) => bodyHasClaimFor(c.body, sourceKey));
}
