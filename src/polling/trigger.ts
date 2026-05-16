import type { RawComment } from "./types.js";

export type TriggerMatch = {
  comment: RawComment;
  repo: string;
  taskDescription: string;
};

export function detectTrigger(
  comment: RawComment,
  repo: string,
  keyword: string,
): TriggerMatch | null {
  const body = comment.body.trim();
  const kw = keyword.toLowerCase();

  if (!body.toLowerCase().startsWith(kw)) return null;

  const after = body.slice(kw.length);
  if (after.length > 0 && !/^\s/.test(after)) return null;

  return {
    comment,
    repo,
    taskDescription: after.trim(),
  };
}
