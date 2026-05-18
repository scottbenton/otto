import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { OttoLogger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { RawComment } from "./types.js";
import { filterComments, pollRepo, runPollingTick } from "./poller.js";

function makeComment(
  id: number,
  options: { createdAt?: string; login?: string | null } = {},
): RawComment {
  const { createdAt = "2024-01-01T00:00:00Z", login = "alice" } = options;
  return {
    id,
    url: `https://api.github.com/repos/owner/repo/issues/comments/${String(id)}`,
    body: `comment ${String(id)}`,
    user: login === null ? null : { login },
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(id)}`,
    issue_url: "https://api.github.com/repos/owner/repo/issues/1",
  };
}

function makeState(overrides: Partial<{
  lastPolled: string | undefined;
  seenIds: number[];
}>= {}): StateStore {
  const { lastPolled, seenIds = [] } = overrides;
  return {
    getLastPolled: vi.fn().mockReturnValue(lastPolled),
    getSeenCommentIds: vi.fn().mockReturnValue(seenIds),
    setLastPolled: vi.fn().mockResolvedValue(undefined),
    addSeenCommentIds: vi.fn().mockResolvedValue(undefined),
    machineId: "machine-uuid",
  } as unknown as StateStore;
}

function makeClient(issueComments: RawComment[], prComments: RawComment[]): GitHubClient {
  return {
    paginateAll: vi.fn()
      .mockResolvedValueOnce(issueComments)
      .mockResolvedValueOnce(prComments),
  } as unknown as GitHubClient;
}

function mockMethod<T>(target: T, key: keyof T): ReturnType<typeof vi.fn> {
  return Reflect.get(target as object, key) as ReturnType<typeof vi.fn>;
}

function makeLogger(): OttoLogger {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as OttoLogger;
  vi.mocked(logger.child).mockReturnValue(logger);
  return logger;
}

function makeStatusComment(id: number): RawComment {
  return {
    ...makeComment(id, { login: "alice" }),
    body: "<!-- otto:v1 status run=abc machine=xyz source=s -->\nStatus: running",
  };
}

describe("filterComments()", () => {
  it("keeps comments from the authenticated user", () => {
    const comment = makeComment(1);
    expect(filterComments([comment], "alice", undefined)).toEqual([comment]);
  });

  it("discards comments from other users", () => {
    const comment = makeComment(1, { login: "bob" });
    expect(filterComments([comment], "alice", undefined)).toHaveLength(0);
  });

  it("discards comments with null user", () => {
    const comment = makeComment(1, { login: null });
    expect(filterComments([comment], "alice", undefined)).toHaveLength(0);
  });

  it("discards otto status comments by header marker even when posted by the authenticated user", () => {
    const comment = makeStatusComment(1);
    expect(filterComments([comment], "alice", undefined)).toHaveLength(0);
  });

  it("keeps comments created at or after lastPolled", () => {
    const comment = makeComment(1, { createdAt: "2024-06-01T12:00:00.000Z" });
    expect(filterComments([comment], "alice", "2024-06-01T12:00:00.000Z")).toEqual([comment]);
  });

  it("discards comments created before lastPolled", () => {
    const comment = makeComment(1, { createdAt: "2024-06-01T11:59:59.000Z" });
    expect(filterComments([comment], "alice", "2024-06-01T12:00:00.000Z")).toHaveLength(0);
  });

  it("skips the created_at gate when lastPolled is undefined", () => {
    const old = makeComment(1, { createdAt: "2020-01-01T00:00:00Z" });
    expect(filterComments([old], "alice", undefined)).toEqual([old]);
  });

  it("applies author gate before created_at gate", () => {
    const foreign = makeComment(1, { login: "bob", createdAt: "2099-01-01T00:00:00Z" });
    expect(filterComments([foreign], "alice", undefined)).toHaveLength(0);
  });
});

describe("pollRepo()", () => {
  it("fetches issue comments and PR comments for the repo", async () => {
    const client = makeClient([makeComment(1)], [makeComment(2)]);
    const state = makeState();

    await pollRepo(client, state, "owner/repo", "alice");

    expect(mockMethod(client, "paginateAll")).toHaveBeenCalledTimes(2);
    const calls = mockMethod(client, "paginateAll").mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[0]).toBe("/repos/owner/repo/issues/comments");
    expect(calls[1]?.[0]).toBe("/repos/owner/repo/pulls/comments");
  });

  it("passes since param derived from lastPolled minus one second", async () => {
    const client = makeClient([], []);
    const state = makeState({ lastPolled: "2024-06-01T12:00:10.000Z" });

    await pollRepo(client, state, "owner/repo", "alice");

    const calls = mockMethod(client, "paginateAll").mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[1]?.since).toBe("2024-06-01T12:00:09.000Z");
  });

  it("omits since param when no lastPolled is stored", async () => {
    const client = makeClient([], []);
    const state = makeState({ lastPolled: undefined });

    await pollRepo(client, state, "owner/repo", "alice");

    const calls = mockMethod(client, "paginateAll").mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[1]?.since).toBeUndefined();
  });

  it("returns only new comment IDs not in seenCommentIds", async () => {
    const client = makeClient([makeComment(1), makeComment(2)], [makeComment(3)]);
    const state = makeState({ seenIds: [1] });

    const result = await pollRepo(client, state, "owner/repo", "alice");

    expect(result.map((c) => c.id)).toEqual([2, 3]);
  });

  it("persists new comment IDs to state", async () => {
    const client = makeClient([makeComment(10), makeComment(20)], []);
    const state = makeState();

    await pollRepo(client, state, "owner/repo", "alice");

    expect(mockMethod(state, "addSeenCommentIds")).toHaveBeenCalledWith("owner/repo", [10, 20]);
  });

  it("updates lastPolled after a successful poll", async () => {
    const client = makeClient([], []);
    const state = makeState();

    await pollRepo(client, state, "owner/repo", "alice");

    expect(mockMethod(state, "setLastPolled")).toHaveBeenCalledWith(
      "owner/repo",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("skips addSeenCommentIds when no new comments found", async () => {
    const client = makeClient([makeComment(1)], []);
    const state = makeState({ seenIds: [1] });

    await pollRepo(client, state, "owner/repo", "alice");

    expect(mockMethod(state, "addSeenCommentIds")).not.toHaveBeenCalled();
  });

  it("returns an empty array when all comments are already seen", async () => {
    const client = makeClient([makeComment(1), makeComment(2)], []);
    const state = makeState({ seenIds: [1, 2] });

    const result = await pollRepo(client, state, "owner/repo", "alice");

    expect(result).toHaveLength(0);
  });

  it("filters out comments from other users before returning", async () => {
    const own = makeComment(1, { login: "alice" });
    const foreign = makeComment(2, { login: "bob" });
    const client = makeClient([own, foreign], []);
    const state = makeState();

    const result = await pollRepo(client, state, "owner/repo", "alice");

    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("filters out otto status comments before returning", async () => {
    const trigger = makeComment(1, { login: "alice" });
    const status = makeStatusComment(2);
    const client = makeClient([trigger, status], []);
    const state = makeState();

    const result = await pollRepo(client, state, "owner/repo", "alice");

    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("filters out comments with created_at before lastPolled", async () => {
    const fresh = makeComment(1, { createdAt: "2024-06-01T12:00:10.000Z" });
    const stale = makeComment(2, { createdAt: "2024-06-01T11:59:58.000Z" });
    const client = makeClient([fresh, stale], []);
    const state = makeState({ lastPolled: "2024-06-01T12:00:00.000Z" });

    const result = await pollRepo(client, state, "owner/repo", "alice");

    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("logs poll tick start and completion at debug level", async () => {
    const logger = makeLogger();
    const client = makeClient([makeComment(1)], []);
    const state = makeState();

    await pollRepo(client, state, "owner/repo", "alice", logger);

    expect(logger.child).toHaveBeenCalledWith({ repo: "owner/repo" });
    expect(logger.debug).toHaveBeenCalledWith({ since: undefined }, "poll tick started");
    expect(logger.debug).toHaveBeenCalledWith(
      {
        issueCommentCount: 1,
        prCommentCount: 0,
        newCommentCount: 1,
        filteredCommentCount: 1,
      },
      "poll tick completed",
    );
  });

  it("logs aggregate filtered comment counts without per-comment noise", async () => {
    const logger = makeLogger();
    const fresh = makeComment(1, { login: "alice", createdAt: "2024-06-01T12:00:10.000Z" });
    const foreign = makeComment(2, { login: "bob", createdAt: "2024-06-01T12:00:10.000Z" });
    const stale = makeComment(3, { login: "alice", createdAt: "2024-06-01T11:59:58.000Z" });
    const client = makeClient([fresh, foreign, stale], []);
    const state = makeState({ lastPolled: "2024-06-01T12:00:00.000Z" });

    await pollRepo(client, state, "owner/repo", "alice", logger);

    expect(logger.debug).toHaveBeenCalledWith(
      {
        filteredCount: 2,
        filteredByOwnComment: 1,
        filteredByStatusComment: 0,
        filteredByCreatedBeforeLastPoll: 1,
      },
      "comments filtered",
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 2 }),
      "comment filtered",
    );
  });
});

describe("runPollingTick()", () => {
  it("returns a map of repo -> new comments", async () => {
    const comment = makeComment(99);
    const client = makeClient([comment], []);
    const state = makeState();

    const result = await runPollingTick(client, state, ["owner/repo"], "alice");

    expect(result.get("owner/repo")).toEqual([comment]);
  });

  it("still returns successful repos when one repo fails", async () => {
    const comment = makeComment(1);
    const client = {
      paginateAll: vi.fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce([comment])
        .mockResolvedValueOnce([]),
    } as unknown as GitHubClient;
    const state = makeState();

    const result = await runPollingTick(client, state, ["bad/repo", "good/repo"], "alice");

    expect(result.has("bad/repo")).toBe(false);
    expect(result.get("good/repo")).toEqual([comment]);
  });

  it("logs an error when a repo poll fails", async () => {
    const logger = makeLogger();
    const client = {
      paginateAll: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as GitHubClient;
    const state = makeState();

    await runPollingTick(client, state, ["bad/repo"], "alice", logger);

    expect(logger.error).toHaveBeenCalledWith({ error: "timeout" }, "repo poll failed");
  });

  it("runs repos in parallel (both paginateAll calls start before either resolves)", async () => {
    const order: string[] = [];
    const client = {
      paginateAll: vi.fn().mockImplementation((path: string) => {
        order.push(`start:${path}`);
        return Promise.resolve([]).then((v) => { order.push(`end:${path}`); return v; });
      }),
    } as unknown as GitHubClient;
    const state = makeState();

    await runPollingTick(client, state, ["a/repo", "b/repo"], "alice");

    // All four starts should appear before any end (parallel execution)
    const starts = order.filter((e) => e.startsWith("start:"));
    expect(starts).toHaveLength(4);
  });
});
