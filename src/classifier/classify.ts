import type { SourceType } from "../context/types.js";

export type TaskType =
  | "answer"
  | "modify_existing_pr"
  | "implement_issue"
  | "clarify"
  | "ignore";

export type TaskClassification = {
  type: TaskType;
};

// Words that match the trigger but aren't real work requests.
const RESERVED_KEYWORDS = new Set(["retry", "cancel", "stop", "done", "thanks", "ok"]);

const QUESTION_RE = /\b(why|what|how|explain|where|when|which)\b/i;
const ACTION_RE =
  /\b(fix|change|update|add|remove|delete|refactor|revert|implement|create|write|make|move|rename|replace|extract|clean|improve|optimize)\b/i;

export function classifyTask(
  taskDescription: string,
  sourceType: SourceType,
): TaskClassification {
  const text = taskDescription.trim();

  if (RESERVED_KEYWORDS.has(text.toLowerCase())) {
    return { type: "ignore" };
  }

  if (text.length === 0) {
    return { type: "clarify" };
  }

  const hasQuestion = QUESTION_RE.test(text);
  const hasAction = ACTION_RE.test(text);

  if (hasQuestion && !hasAction) {
    return { type: "answer" };
  }

  if (hasAction) {
    const isPr = sourceType === "pr_line_comment" || sourceType === "pr_conversation_comment";
    return { type: isPr ? "modify_existing_pr" : "implement_issue" };
  }

  return { type: "clarify" };
}
