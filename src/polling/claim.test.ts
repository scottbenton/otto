import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment } from "./types.js";
import { claimOrAbort, commentSourceKey, isAlreadyClaimed } from "./claim.js";

function makeIssueComment(id: number): IssueComment {
  return {
    id,
    url: `https://api.github.com/repos/owner/repo/issues/comments/${String(id)}`,
    body: "hey otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(id)}`,
    issue_url: "https://api.github.com/repos/owner/repo/issues/1",
  };
}

function makePrComment(id: number): PullRequestReviewComment {
  return {
    id,
    url: `https://api.github.com/repos/owner/repo/pulls/comments/${String(id)}`,
    body: "hey otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/pull/2#pullrequestreviewcomment-${String(id)}`,
    pull_request_url: "https://api.github.com/repos/owner/repo/pulls/2",
  };
}

type ThreadComment = { id?: number; body: string; created_at?: string };

function makeClient(
  threadComments: ThreadComment[],
  postResult?: { id: number; created_at: string },
): GitHubClient {
  return {
    paginateAll: vi.fn().mockResolvedValue(threadComments),
    request: vi.fn().mockResolvedValue(postResult ?? { id: 9001, created_at: "2024-01-01T12:00:00Z" }),
  } as unknown as GitHubClient;
}

function paginateAllMock(client: GitHubClient): ReturnType<typeof vi.fn> {
  return Reflect.get(client, "paginateAll") as ReturnType<typeof vi.fn>;
}

function requestMock(client: GitHubClient): ReturnType<typeof vi.fn> {
  return Reflect.get(client, "request") as ReturnType<typeof vi.fn>;
}

function statusBody(sourceKey: string): string {
  return `<!-- otto:v1 status run=run-uuid machine=machine-uuid source=${sourceKey} -->\n\nOtto is working on this.`;
}

describe("commentSourceKey()", () => {
  it("returns issue_comment:<id> for issue comments", () => {
    expect(commentSourceKey(makeIssueComment(42))).toBe("issue_comment:42");
  });

  it("returns pr_review_comment:<id> for PR review comments", () => {
    expect(commentSourceKey(makePrComment(99))).toBe("pr_review_comment:99");
  });
});

describe("isAlreadyClaimed()", () => {
  it("returns false when no comments on the thread", async () => {
    const client = makeClient([]);
    expect(await isAlreadyClaimed(client, makeIssueComment(1))).toBe(false);
  });

  it("returns false when thread comments have no status marker", async () => {
    const client = makeClient([{ body: "just a normal reply" }]);
    expect(await isAlreadyClaimed(client, makeIssueComment(1))).toBe(false);
  });

  it("returns true when a matching status comment exists for an issue comment", async () => {
    const trigger = makeIssueComment(123);
    const client = makeClient([{ body: statusBody("issue_comment:123") }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(true);
  });

  it("returns true when a matching status comment exists for a PR review comment", async () => {
    const trigger = makePrComment(456);
    const client = makeClient([{ body: statusBody("pr_review_comment:456") }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(true);
  });

  it("returns false when status comment source is for a different comment id", async () => {
    const trigger = makeIssueComment(123);
    const client = makeClient([{ body: statusBody("issue_comment:999") }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(false);
  });

  it("returns false when status comment source type does not match", async () => {
    const trigger = makeIssueComment(123);
    const client = makeClient([{ body: statusBody("pr_review_comment:123") }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(false);
  });

  it("does not match a longer id that has the target id as a prefix", async () => {
    const trigger = makeIssueComment(12);
    const client = makeClient([{ body: statusBody("issue_comment:123") }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(false);
  });

  it("fetches from the issue comments URL for issue comments", async () => {
    const trigger = makeIssueComment(1);
    const client = makeClient([]);
    await isAlreadyClaimed(client, trigger);
    expect(paginateAllMock(client)).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/1/comments",
    );
  });

  it("fetches from the PR review comments URL for PR review comments", async () => {
    const trigger = makePrComment(1);
    const client = makeClient([]);
    await isAlreadyClaimed(client, trigger);
    expect(paginateAllMock(client)).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/2/comments",
    );
  });

  it("returns true even when the match is not the first comment", async () => {
    const trigger = makeIssueComment(7);
    const client = makeClient([
      { body: "unrelated reply" },
      { body: statusBody("issue_comment:7") },
      { body: "another reply" },
    ]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(true);
  });

  it("handles multiline status comment bodies", async () => {
    const trigger = makeIssueComment(5);
    const body = `<!-- otto:v1 status\n  run=abc machine=def source=issue_comment:5\n-->`;
    const client = makeClient([{ body }]);
    expect(await isAlreadyClaimed(client, trigger)).toBe(true);
  });
});

describe("claimOrAbort()", () => {
  const MACHINE_ID = "machine-uuid-1234";

  function makeStatusComment(runId: string, sourceKey: string, id: number, created_at: string): ThreadComment {
    return {
      id,
      body: `<!-- otto:v1 status run=${runId} machine=${MACHINE_ID} source=${sourceKey} -->\n**[Otto]** Status: running`,
      created_at,
    };
  }

  it("returns { claimed: false } when thread is already claimed before posting", async () => {
    const trigger = makeIssueComment(1);
    const existing = statusBody("issue_comment:1");
    const client = makeClient([{ body: existing }]);

    expect(await claimOrAbort(client, trigger, MACHINE_ID)).toEqual({ claimed: false });
    expect(requestMock(client)).not.toHaveBeenCalled();
  });

  it("posts to the issue comments URL for an issue comment trigger", async () => {
    const trigger = makeIssueComment(1);
    const client = makeClient([], { id: 42, created_at: "2024-01-01T12:00:00Z" });

    await claimOrAbort(client, trigger, MACHINE_ID);

    const [url, opts] = requestMock(client).mock.calls[0] as [string, { method: string; body: { body: string } }];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues/1/comments");
    expect(opts.method).toBe("POST");
  });

  it("posts to the PR reply URL for a PR review comment trigger", async () => {
    const trigger = makePrComment(77);
    const client = makeClient([], { id: 88, created_at: "2024-01-01T12:00:00Z" });

    await claimOrAbort(client, trigger, MACHINE_ID);

    const [url] = requestMock(client).mock.calls[0] as [string];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/2/comments/77/replies");
  });

  it("status comment body contains the otto:v1 marker with correct source", async () => {
    const trigger = makeIssueComment(5);
    const client = makeClient([], { id: 99, created_at: "2024-01-01T12:00:00Z" });

    await claimOrAbort(client, trigger, MACHINE_ID);

    const [, opts] = requestMock(client).mock.calls[0] as [string, { body: { body: string } }];
    expect(opts.body.body).toContain("otto:v1 status");
    expect(opts.body.body).toContain(`source=issue_comment:5`);
    expect(opts.body.body).toContain(`machine=${MACHINE_ID}`);
    expect(opts.body.body).toContain("Status: running");
  });

  it("returns { claimed: true } when no duplicate found after posting", async () => {
    const trigger = makeIssueComment(1);
    const client = makeClient([], { id: 42, created_at: "2024-01-01T12:00:00Z" });

    const result = await claimOrAbort(client, trigger, MACHINE_ID);

    expect(result.claimed).toBe(true);
    if (result.claimed) {
      expect(result.statusCommentId).toBe(42);
      expect(typeof result.runId).toBe("string");
    }
  });

  it("returns { claimed: true } when we have the earlier created_at (winner)", async () => {
    const trigger = makeIssueComment(1);
    // paginateAll called twice: gate check (empty), then duplicate scan (two claims, ours id=42 is earliest)
    const client = {
      paginateAll: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeStatusComment("our-run", "issue_comment:1", 42, "2024-01-01T12:00:00Z"),
          makeStatusComment("other-run", "issue_comment:1", 43, "2024-01-01T12:00:01Z"),
        ]),
      // request returns our posted comment with id=42 (same as the winner entry)
      request: vi.fn().mockResolvedValue({ id: 42, created_at: "2024-01-01T12:00:00Z" }),
    } as unknown as GitHubClient;

    const result = await claimOrAbort(client, trigger, MACHINE_ID);
    expect(result.claimed).toBe(true);
    expect(requestMock(client)).toHaveBeenCalledTimes(1);
  });

  it("returns { claimed: false } and patches abort when we lose the race", async () => {
    const trigger = makeIssueComment(1);
    const client = {
      paginateAll: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeStatusComment("other-run", "issue_comment:1", 43, "2024-01-01T12:00:00Z"),
          makeStatusComment("our-run", "issue_comment:1", 42, "2024-01-01T12:00:01Z"),
        ]),
      request: vi.fn().mockResolvedValue({ id: 42, created_at: "2024-01-01T12:00:01Z" }),
    } as unknown as GitHubClient;

    const result = await claimOrAbort(client, trigger, MACHINE_ID);
    expect(result.claimed).toBe(false);

    const calls = requestMock(client).mock.calls as [string, { method: string; body: { body: string } }][];
    expect(calls).toHaveLength(2);
    const patchCall = calls[1];
    expect(patchCall).toBeDefined();
    if (patchCall === undefined) return;
    expect(patchCall[0]).toBe("https://api.github.com/repos/owner/repo/issues/comments/42");
    expect(patchCall[1].method).toBe("PATCH");
    expect(patchCall[1].body.body).toContain("aborted (duplicate claim)");
  });

  it("patches the correct PR review comment update URL when losing the race", async () => {
    const trigger = makePrComment(77);
    const client = {
      paginateAll: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeStatusComment("other-run", "pr_review_comment:77", 200, "2024-01-01T12:00:00Z"),
          makeStatusComment("our-run", "pr_review_comment:77", 201, "2024-01-01T12:00:01Z"),
        ]),
      request: vi.fn().mockResolvedValue({ id: 201, created_at: "2024-01-01T12:00:01Z" }),
    } as unknown as GitHubClient;

    await claimOrAbort(client, trigger, MACHINE_ID);

    const calls = requestMock(client).mock.calls as [string][];
    expect(calls[1]?.[0]).toBe("https://api.github.com/repos/owner/repo/pulls/comments/201");
  });
});
