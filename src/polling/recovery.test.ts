import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment } from "./types.js";
import { recoverStaleComments } from "./recovery.js";

const MY_MACHINE = "my-machine-uuid";
const OTHER_MACHINE = "other-machine-uuid";
const AUTH_USER = "alice";

function runningBody(machineId: string, sourceKey = "issue_comment:1"): string {
  return `<!-- otto:v1 status run=run-uuid machine=${machineId} source=${sourceKey} -->\nStatus: running\n\n---\n[🤖 Otto](https://github.com/scottbenton/otto)`;
}

function makeIssueComment(
  id: number,
  body: string,
  login = AUTH_USER,
): IssueComment {
  return {
    id,
    url: `https://api.github.com/repos/owner/repo/issues/comments/${String(id)}`,
    body,
    user: { login },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(id)}`,
    issue_url: "https://api.github.com/repos/owner/repo/issues/1",
  };
}

function makePrComment(id: number, body: string): PullRequestReviewComment {
  return {
    id,
    url: `https://api.github.com/repos/owner/repo/pulls/comments/${String(id)}`,
    body,
    user: { login: AUTH_USER },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/pull/2#pullrequestreviewcomment-${String(id)}`,
    pull_request_url: "https://api.github.com/repos/owner/repo/pulls/2",
  };
}

function makeClient(issueComments: IssueComment[] = [], prComments: PullRequestReviewComment[] = []): GitHubClient {
  return {
    paginateAll: vi.fn()
      .mockResolvedValueOnce(issueComments)
      .mockResolvedValueOnce(prComments),
    request: vi.fn().mockResolvedValue({}),
  } as unknown as GitHubClient;
}

describe("recoverStaleComments()", () => {
  it("does nothing when there are no comments", async () => {
    const client = makeClient();
    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("patches a stale running issue comment from this machine", async () => {
    const stale = makeIssueComment(42, runningBody(MY_MACHINE));
    const client = makeClient([stale]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).toHaveBeenCalledOnce();
    const [url, opts] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { method: string; body: { body: string } }];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues/comments/42");
    expect(opts.method).toBe("PATCH");
    expect(opts.body.body).toContain("Status: interrupted");
    expect(opts.body.body).toContain("re-trigger");
  });

  it("patches a stale running PR review comment from this machine", async () => {
    const stale = makePrComment(99, runningBody(MY_MACHINE, "pr_review_comment:5"));
    const client = makeClient([], [stale]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).toHaveBeenCalledOnce();
    const [url] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://api.github.com/repos/owner/repo/pulls/comments/99");
  });

  it("leaves comments from a different machine UUID untouched", async () => {
    const foreign = makeIssueComment(1, runningBody(OTHER_MACHINE));
    const client = makeClient([foreign]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("leaves comments not authored by the authenticated user untouched", async () => {
    const other = makeIssueComment(1, runningBody(MY_MACHINE), "bot-user");
    const client = makeClient([other]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("leaves comments with Status: running from this machine but not otto markers untouched", async () => {
    const plain = makeIssueComment(1, "Status: running but no otto marker");
    const client = makeClient([plain]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not patch comments that are already interrupted", async () => {
    const interrupted = makeIssueComment(
      1,
      `<!-- otto:v1 status run=r machine=${MY_MACHINE} source=issue_comment:1 -->\nStatus: interrupted`,
    );
    const client = makeClient([interrupted]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("patches multiple stale comments in the same repo", async () => {
    const stale1 = makeIssueComment(1, runningBody(MY_MACHINE, "issue_comment:10"));
    const stale2 = makeIssueComment(2, runningBody(MY_MACHINE, "issue_comment:11"));
    const client = makeClient([stale1, stale2]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("preserves the original run and source key in the patched body", async () => {
    const stale = makeIssueComment(
      5,
      `<!-- otto:v1 status run=original-run machine=${MY_MACHINE} source=issue_comment:99 -->\nStatus: running`,
    );
    const client = makeClient([stale]);

    await recoverStaleComments(client, ["owner/repo"], MY_MACHINE, AUTH_USER);

    const [, opts] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: { body: string } }];
    expect(opts.body.body).toContain("run=original-run");
    expect(opts.body.body).toContain("source=issue_comment:99");
  });

  it("scans the correct repo path", async () => {
    const client = makeClient();
    await recoverStaleComments(client, ["myorg/myrepo"], MY_MACHINE, AUTH_USER);

    expect(client.paginateAll).toHaveBeenCalledWith("/repos/myorg/myrepo/issues/comments");
    expect(client.paginateAll).toHaveBeenCalledWith("/repos/myorg/myrepo/pulls/comments");
  });
});
