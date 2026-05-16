import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { StateStore } from "../state/store.js";
import type { RawComment } from "./types.js";
import { pollRepo, runPollingTick } from "./poller.js";

function makeComment(id: number, createdAt = "2024-01-01T00:00:00Z"): RawComment {
  return {
    id,
    body: `comment ${String(id)}`,
    user: { login: "alice" },
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

describe("pollRepo()", () => {
  it("fetches issue comments and PR comments for the repo", async () => {
    const client = makeClient([makeComment(1)], [makeComment(2)]);
    const state = makeState();

    await pollRepo(client, state, "owner/repo");

    expect(client.paginateAll).toHaveBeenCalledTimes(2);
    const calls = (client.paginateAll as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[0]).toBe("/repos/owner/repo/issues/comments");
    expect(calls[1]?.[0]).toBe("/repos/owner/repo/pulls/comments");
  });

  it("passes since param derived from lastPolled minus one second", async () => {
    const client = makeClient([], []);
    const state = makeState({ lastPolled: "2024-06-01T12:00:10.000Z" });

    await pollRepo(client, state, "owner/repo");

    const calls = (client.paginateAll as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[1]?.since).toBe("2024-06-01T12:00:09.000Z");
  });

  it("omits since param when no lastPolled is stored", async () => {
    const client = makeClient([], []);
    const state = makeState({ lastPolled: undefined });

    await pollRepo(client, state, "owner/repo");

    const calls = (client.paginateAll as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, string>][];
    expect(calls[0]?.[1]?.since).toBeUndefined();
  });

  it("returns only new comment IDs not in seenCommentIds", async () => {
    const client = makeClient([makeComment(1), makeComment(2)], [makeComment(3)]);
    const state = makeState({ seenIds: [1] });

    const result = await pollRepo(client, state, "owner/repo");

    expect(result.map((c) => c.id)).toEqual([2, 3]);
  });

  it("persists new comment IDs to state", async () => {
    const client = makeClient([makeComment(10), makeComment(20)], []);
    const state = makeState();

    await pollRepo(client, state, "owner/repo");

    expect(state.addSeenCommentIds).toHaveBeenCalledWith("owner/repo", [10, 20]);
  });

  it("updates lastPolled after a successful poll", async () => {
    const client = makeClient([], []);
    const state = makeState();

    await pollRepo(client, state, "owner/repo");

    expect(state.setLastPolled).toHaveBeenCalledWith(
      "owner/repo",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("skips addSeenCommentIds when no new comments found", async () => {
    const client = makeClient([makeComment(1)], []);
    const state = makeState({ seenIds: [1] });

    await pollRepo(client, state, "owner/repo");

    expect(state.addSeenCommentIds).not.toHaveBeenCalled();
  });

  it("returns an empty array when all comments are already seen", async () => {
    const client = makeClient([makeComment(1), makeComment(2)], []);
    const state = makeState({ seenIds: [1, 2] });

    const result = await pollRepo(client, state, "owner/repo");

    expect(result).toHaveLength(0);
  });
});

describe("runPollingTick()", () => {
  it("returns a map of repo -> new comments", async () => {
    const comment = makeComment(99);
    const client = makeClient([comment], []);
    const state = makeState();

    const result = await runPollingTick(client, state, ["owner/repo"]);

    expect(result.get("owner/repo")).toEqual([comment]);
  });

  it("still returns successful repos when one repo fails", async () => {
    const client = {
      paginateAll: vi.fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce([makeComment(1)])
        .mockResolvedValueOnce([]),
    } as unknown as GitHubClient;
    const state = makeState();

    const result = await runPollingTick(client, state, ["bad/repo", "good/repo"]);

    expect(result.has("bad/repo")).toBe(false);
    expect(result.get("good/repo")).toEqual([makeComment(1)]);
  });

  it("logs an error to stderr when a repo poll fails", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = {
      paginateAll: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as GitHubClient;
    const state = makeState();

    await runPollingTick(client, state, ["bad/repo"]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    stderrSpy.mockRestore();
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

    await runPollingTick(client, state, ["a/repo", "b/repo"]);

    // All four starts should appear before any end (parallel execution)
    const starts = order.filter((e) => e.startsWith("start:"));
    expect(starts).toHaveLength(4);
  });
});
