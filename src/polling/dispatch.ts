import type { StateStore } from "../state/store.js";
import type { TriggerMatch } from "./trigger.js";

export function filterUnseenTriggers(
  matches: TriggerMatch[],
  state: StateStore,
  repo: string,
): TriggerMatch[] {
  const seen = new Set(state.getSeenCommentIds(repo));
  return matches.filter((m) => !seen.has(m.comment.id));
}
