import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment } from "./types.js";
import {
  abortedDuplicateClaimStatus,
  buildStatusComment,
  completedStatus,
  failedStatus,
  interruptedStatus,
  statusCommentUrl,
  updateStatusComment,
} from "./status.js";

const IDENTITY = {
  runId: "run-uuid",
  machineId: "machine-uuid",
  sourceKey: "issue_comment:1",
};

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

function makeClient(): GitHubClient {
  return {
    request: vi.fn().mockResolvedValue({}),
  } as unknown as GitHubClient;
}

function requestMock(client: GitHubClient): ReturnType<typeof vi.fn> {
  return Reflect.get(client, "request") as ReturnType<typeof vi.fn>;
}

describe("statusCommentUrl()", () => {
  it("builds the issue comment PATCH URL for issue status comments", () => {
    expect(statusCommentUrl(makeIssueComment(1), 42)).toBe(
      "https://api.github.com/repos/owner/repo/issues/comments/42",
    );
  });

  it("builds the PR review comment PATCH URL for PR review status replies", () => {
    expect(statusCommentUrl(makePrComment(7), 99)).toBe(
      "https://api.github.com/repos/owner/repo/pulls/comments/99",
    );
  });
});

describe("buildStatusComment()", () => {
  it("formats a completed status with branch and PR links", () => {
    const body = buildStatusComment(
      IDENTITY,
      completedStatus({
        branchUrl: "https://github.com/owner/repo/tree/otto-branch",
        pullRequestUrl: "https://github.com/owner/repo/pull/123",
      }),
    );

    expect(body).toContain("Status: completed");
    expect(body).toContain("Branch: https://github.com/owner/repo/tree/otto-branch");
    expect(body).toContain("Pull request: https://github.com/owner/repo/pull/123");
  });

  it("formats a failed status with canned retry guidance", () => {
    const body = buildStatusComment(IDENTITY, failedStatus("timeout"));

    expect(body).toContain("Status: failed");
    expect(body).toContain("The agent command timed out.");
    expect(body).toContain("Retry:");
  });

  it("does not include caller-provided raw output in failed statuses", () => {
    const body = buildStatusComment(IDENTITY, failedStatus("runner-failed"));

    expect(body).not.toContain("/Users/");
    expect(body).not.toContain("GITHUB_TOKEN");
    expect(body).not.toContain("stack trace");
  });

  it("formats interrupted and duplicate-abort statuses", () => {
    expect(buildStatusComment(IDENTITY, interruptedStatus())).toContain("Status: interrupted");
    expect(buildStatusComment(IDENTITY, abortedDuplicateClaimStatus())).toContain(
      "Status: aborted (duplicate claim)",
    );
  });
});

describe("updateStatusComment()", () => {
  it("patches status comments in place", async () => {
    const client = makeClient();

    await updateStatusComment(
      client,
      makeIssueComment(1),
      42,
      IDENTITY,
      failedStatus("push-failed"),
    );

    const [url, opts] = requestMock(client).mock.calls[0] as [
      string,
      { method: string; body: { body: string } },
    ];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues/comments/42");
    expect(opts.method).toBe("PATCH");
    expect(opts.body.body).toContain("Status: failed");
  });
});
