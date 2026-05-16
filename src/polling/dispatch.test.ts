import { describe, expect, it, vi } from "vitest";

import type { StateStore } from "../state/store.js";
import type { TriggerMatch } from "./trigger.js";
import { filterUnseenTriggers } from "./dispatch.js";

function makeMatch(id: number, repo = "owner/repo"): TriggerMatch {
  return {
    comment: {
      id,
      body: "hey otto fix this",
      user: { login: "alice" },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(id)}`,
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    },
    repo,
    taskDescription: "hey otto fix this",
  };
}

function makeState(seenIds: number[] = []): StateStore {
  return {
    getSeenCommentIds: vi.fn().mockReturnValue(seenIds),
  } as unknown as StateStore;
}

function getSeenCommentIdsMock(state: StateStore): ReturnType<typeof vi.fn> {
  return Reflect.get(state, "getSeenCommentIds") as ReturnType<typeof vi.fn>;
}

describe("filterUnseenTriggers()", () => {
  it("returns all matches when none are in seenIds", () => {
    const matches = [makeMatch(1), makeMatch(2)];
    const state = makeState([]);

    expect(filterUnseenTriggers(matches, state, "owner/repo")).toEqual(matches);
  });

  it("filters out matches whose comment ID is in seenIds", () => {
    const matches = [makeMatch(1), makeMatch(2), makeMatch(3)];
    const state = makeState([2]);

    const result = filterUnseenTriggers(matches, state, "owner/repo");
    expect(result.map((m) => m.comment.id)).toEqual([1, 3]);
  });

  it("returns empty array when all matches are already seen", () => {
    const matches = [makeMatch(10), makeMatch(20)];
    const state = makeState([10, 20]);

    expect(filterUnseenTriggers(matches, state, "owner/repo")).toHaveLength(0);
  });

  it("returns empty array when given no matches", () => {
    const state = makeState([1, 2]);

    expect(filterUnseenTriggers([], state, "owner/repo")).toHaveLength(0);
  });

  it("looks up seenIds for the correct repo", () => {
    const matches = [makeMatch(1, "org/repo-a")];
    const state = makeState([]);

    filterUnseenTriggers(matches, state, "org/repo-a");

    expect(getSeenCommentIdsMock(state)).toHaveBeenCalledWith("org/repo-a");
  });
});
