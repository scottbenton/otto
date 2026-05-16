import type { RawComment } from "./types.js";

export type TriggerMatch = {
  comment: RawComment;
  repo: string;
  taskDescription: string;
};

// Escape special regex characters in the keyword so user-configured values are safe.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectTrigger(
  comment: RawComment,
  repo: string,
  keyword: string,
): TriggerMatch | null {
  const body = comment.body.trim();
  const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");

  if (!pattern.test(body)) return null;

  return {
    comment,
    repo,
    taskDescription: body,
  };
}
