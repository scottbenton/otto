import { describe, expect, it, vi } from "vitest";

import type { StateStore } from "../state/store.js";
import type { TriggerMatch } from "./trigger.js";
import type { PullRequestReviewComment } from "./types.js";
import { filterUnseenTriggers, getTriggerTargetKey, RunConcurrencyGate } from "./dispatch.js";

function makeMatch(id: number, repo = "owner/repo"): TriggerMatch {
  return {
    comment: {
      id,
      body: "hey otto fix this",
      user: { login: "alice" },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      url: `https://api.github.com/repos/owner/repo/issues/comments/${String(id)}`,
      html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(id)}`,
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    },
    repo,
    taskDescription: "hey otto fix this",
  };
}

function makePrMatch(id: number, repo = "owner/repo"): TriggerMatch {
  const comment: PullRequestReviewComment = {
    id,
    body: "hey otto fix this line",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    url: `https://api.github.com/repos/owner/repo/pulls/comments/${String(id)}`,
    html_url: `https://github.com/owner/repo/pull/7#discussion_r${String(id)}`,
    pull_request_url: "https://api.github.com/repos/owner/repo/pulls/7",
  };

  return {
    comment,
    repo,
    taskDescription: "hey otto fix this line",
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

describe("getTriggerTargetKey()", () => {
  it("uses the issue number for issue comment triggers", () => {
    expect(getTriggerTargetKey(makeMatch(1, "org/repo"))).toBe("org/repo#1");
  });

  it("uses the PR number for pull request review comment triggers", () => {
    expect(getTriggerTargetKey(makePrMatch(99, "org/repo"))).toBe("org/repo#7");
  });
});

describe("RunConcurrencyGate", () => {
  it("starts a batch when the target and global capacity are free", () => {
    const gate = new RunConcurrencyGate<string>({ maxConcurrentRuns: 2 });
    const batch = { targetKey: "owner/repo#1", items: ["a"] };

    expect(gate.submit(batch)).toEqual({ status: "started", batch });
    expect(gate.activeRunCount).toBe(1);
    expect(gate.isTargetInFlight("owner/repo#1")).toBe(true);
  });

  it("queues a batch for a target that is already in flight", () => {
    const gate = new RunConcurrencyGate<string>({ maxConcurrentRuns: 2 });
    const first = { targetKey: "owner/repo#1", items: ["a"] };
    const second = { targetKey: "owner/repo#1", items: ["b"] };

    gate.submit(first);

    expect(gate.submit(second)).toEqual({
      status: "queued",
      reason: "target-in-flight",
      batch: second,
    });
    expect(gate.activeRunCount).toBe(1);
    expect(gate.queuedBatchCount).toBe(1);
  });

  it("queues every new batch when the global cap is reached", () => {
    const gate = new RunConcurrencyGate<string>({ maxConcurrentRuns: 1 });
    const first = { targetKey: "owner/repo#1", items: ["a"] };
    const second = { targetKey: "owner/repo#2", items: ["b"] };

    gate.submit(first);

    expect(gate.submit(second)).toEqual({
      status: "queued",
      reason: "global-capacity",
      batch: second,
    });
    expect(gate.activeRunCount).toBe(1);
    expect(gate.queuedBatchCount).toBe(1);
  });

  it("starts queued batches when a run completes", () => {
    const gate = new RunConcurrencyGate<string>({ maxConcurrentRuns: 2 });
    const first = { targetKey: "owner/repo#1", items: ["a"] };
    const second = { targetKey: "owner/repo#1", items: ["b"] };
    const third = { targetKey: "owner/repo#2", items: ["c"] };

    gate.submit(first);
    gate.submit(second);
    gate.submit(third);

    expect(gate.complete("owner/repo#1")).toEqual([second]);
    expect(gate.activeRunCount).toBe(2);
    expect(gate.queuedBatchCount).toBe(0);
    expect(gate.isTargetInFlight("owner/repo#1")).toBe(true);
    expect(gate.isTargetInFlight("owner/repo#2")).toBe(true);
  });

  it("ignores completion for a target that is not in flight", () => {
    const gate = new RunConcurrencyGate<string>({ maxConcurrentRuns: 3 });

    expect(gate.complete("owner/repo#1")).toEqual([]);
    expect(gate.activeRunCount).toBe(0);
  });
});
