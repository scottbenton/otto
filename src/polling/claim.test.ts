import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment } from "./types.js";
import { commentSourceKey, isAlreadyClaimed } from "./claim.js";

function makeIssueComment(id: number): IssueComment {
  return {
    id,
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
    body: "hey otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/pull/2#pullrequestreviewcomment-${String(id)}`,
    pull_request_url: "https://api.github.com/repos/owner/repo/pulls/2",
  };
}

function makeClient(threadComments: { body: string }[]): GitHubClient {
  return {
    paginateAll: vi.fn().mockResolvedValue(threadComments),
  } as unknown as GitHubClient;
}

function paginateAllMock(client: GitHubClient): ReturnType<typeof vi.fn> {
  return Reflect.get(client, "paginateAll") as ReturnType<typeof vi.fn>;
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
