import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment } from "../polling/types.js";
import { hydrateContext } from "./hydrate.js";

const BASE = "https://api.github.com";

function makeIssueComment(issueNumber = 1): IssueComment {
  return {
    id: 100,
    url: `${BASE}/repos/owner/repo/issues/comments/100`,
    body: "otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/issues/${String(issueNumber)}#issuecomment-100`,
    issue_url: `${BASE}/repos/owner/repo/issues/${String(issueNumber)}`,
  };
}

function makePrReviewComment(prNumber = 2): PullRequestReviewComment {
  return {
    id: 200,
    url: `${BASE}/repos/owner/repo/pulls/comments/200`,
    body: "otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/owner/repo/pull/${String(prNumber)}#pullrequestreviewcomment-200`,
    pull_request_url: `${BASE}/repos/owner/repo/pulls/${String(prNumber)}`,
  };
}

function makeIssueResponse(opts: { isPr?: boolean; labels?: string[] } = {}) {
  return {
    number: 1,
    title: "Fix the bug",
    body: "It is broken",
    state: "open",
    user: { login: "alice" },
    labels: (opts.labels ?? ["bug"]).map((name) => ({ name })),
    ...(opts.isPr === true ? { pull_request: { url: `${BASE}/repos/owner/repo/pulls/1` } } : {}),
  };
}

function makePullResponse(base = "main", head = "fix-branch") {
  return { base: { ref: base }, head: { ref: head } };
}

function makeCommentResponse(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    user: { login: "bob" },
    body: `comment ${String(i)}`,
    created_at: "2024-01-01T00:00:00Z",
  }));
}

function makeReviewResponse(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: 2000 + i,
    user: { login: "carol" },
    state: "APPROVED",
    body: null,
    submitted_at: "2024-01-02T00:00:00Z",
  }));
}

function makeClient(opts: {
  issueResponse?: object;
  pullResponse?: object;
  comments?: object[];
  reviews?: object[];
}): GitHubClient {
  const issue = opts.issueResponse ?? makeIssueResponse();
  const pull = opts.pullResponse ?? makePullResponse();
  const comments = opts.comments ?? makeCommentResponse(2);
  const reviews = opts.reviews ?? makeReviewResponse(1);

  return {
    request: vi.fn().mockImplementation((url: string) => {
      if (/\/pulls\/\d+$/.test(url)) return Promise.resolve(pull);
      return Promise.resolve(issue);
    }),
    paginateAll: vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/reviews")) return Promise.resolve(reviews);
      return Promise.resolve(comments);
    }),
  } as unknown as GitHubClient;
}

describe("hydrateContext() — IssueComment on a plain issue", () => {
  it("returns kind: issue", async () => {
    const client = makeClient({ issueResponse: makeIssueResponse({ isPr: false }) });
    const ctx = await hydrateContext(client, makeIssueComment());
    expect(ctx.kind).toBe("issue");
  });

  it("populates owner, repo, and number from issue_url", async () => {
    const client = makeClient({ issueResponse: makeIssueResponse() });
    const ctx = await hydrateContext(client, makeIssueComment(5));
    expect(ctx.owner).toBe("owner");
    expect(ctx.repo).toBe("repo");
    expect(ctx.number).toBe(5);
  });

  it("maps issue fields correctly", async () => {
    const client = makeClient({
      issueResponse: makeIssueResponse({ labels: ["bug", "help wanted"] }),
    });
    const ctx = await hydrateContext(client, makeIssueComment());
    expect(ctx.issue.title).toBe("Fix the bug");
    expect(ctx.issue.body).toBe("It is broken");
    expect(ctx.issue.state).toBe("open");
    expect(ctx.issue.author).toBe("alice");
    expect(ctx.issue.labels).toEqual(["bug", "help wanted"]);
  });

  it("maps thread comments correctly", async () => {
    const client = makeClient({ comments: makeCommentResponse(2) });
    const ctx = await hydrateContext(client, makeIssueComment());
    if (ctx.kind !== "issue") throw new Error("Expected issue");
    expect(ctx.comments).toHaveLength(2);
    expect(ctx.comments[0]).toMatchObject({ id: 1000, author: "bob", body: "comment 0" });
  });

  it("fetches issue details from issue_url", async () => {
    const comment = makeIssueComment(3);
    const client = makeClient({});
    await hydrateContext(client, comment);
    expect(client.request).toHaveBeenCalledWith(comment.issue_url);
  });

  it("fetches comments from issue_url/comments", async () => {
    const comment = makeIssueComment(3);
    const client = makeClient({});
    await hydrateContext(client, comment);
    expect(client.paginateAll).toHaveBeenCalledWith(`${comment.issue_url}/comments`);
  });

  it("sets truncated: false when comments <= 200", async () => {
    const client = makeClient({ comments: makeCommentResponse(200) });
    const ctx = await hydrateContext(client, makeIssueComment());
    if (ctx.kind !== "issue") throw new Error("Expected issue");
    expect(ctx.truncated).toBe(false);
    expect(ctx.comments).toHaveLength(200);
  });

  it("truncates to 200 and sets truncated: true when comments > 200", async () => {
    const client = makeClient({ comments: makeCommentResponse(201) });
    const ctx = await hydrateContext(client, makeIssueComment());
    if (ctx.kind !== "issue") throw new Error("Expected issue");
    expect(ctx.truncated).toBe(true);
    expect(ctx.comments).toHaveLength(200);
  });

  it("handles null comment author", async () => {
    const nullUserComment = [{ id: 1001, user: null, body: "anon", created_at: "2024-01-01T00:00:00Z" }];
    const client = makeClient({ comments: nullUserComment });
    const ctx = await hydrateContext(client, makeIssueComment());
    if (ctx.kind !== "issue") throw new Error("Expected issue");
    expect(ctx.comments[0]?.author).toBeNull();
  });

  it("handles null issue author", async () => {
    const issueNoUser = { ...makeIssueResponse(), user: null };
    const client = makeClient({ issueResponse: issueNoUser });
    const ctx = await hydrateContext(client, makeIssueComment());
    expect(ctx.issue.author).toBeNull();
  });
});

describe("hydrateContext() — IssueComment on a PR (issue has pull_request field)", () => {
  it("returns kind: pull_request", async () => {
    const client = makeClient({ issueResponse: makeIssueResponse({ isPr: true }) });
    const ctx = await hydrateContext(client, makeIssueComment(1));
    expect(ctx.kind).toBe("pull_request");
  });

  it("includes pullRequest branch refs", async () => {
    const client = makeClient({
      issueResponse: makeIssueResponse({ isPr: true }),
      pullResponse: makePullResponse("main", "feature-branch"),
    });
    const ctx = await hydrateContext(client, makeIssueComment(1));
    if (ctx.kind !== "pull_request") throw new Error("Expected pull_request");
    expect(ctx.pullRequest.baseBranch).toBe("main");
    expect(ctx.pullRequest.headBranch).toBe("feature-branch");
  });

  it("includes reviews", async () => {
    const client = makeClient({
      issueResponse: makeIssueResponse({ isPr: true }),
      reviews: makeReviewResponse(2),
    });
    const ctx = await hydrateContext(client, makeIssueComment(1));
    if (ctx.kind !== "pull_request") throw new Error("Expected pull_request");
    expect(ctx.reviews).toHaveLength(2);
    expect(ctx.reviews[0]).toMatchObject({ id: 2000, author: "carol", state: "APPROVED" });
  });

  it("does not fetch thread comments", async () => {
    const client = makeClient({ issueResponse: makeIssueResponse({ isPr: true }) });
    await hydrateContext(client, makeIssueComment(1));
    const paginateCalls = (client.paginateAll as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(paginateCalls.every(([url]) => !url.endsWith("/comments"))).toBe(true);
  });

  it("fetches pulls URL derived from issue_url", async () => {
    const comment = makeIssueComment(1);
    const client = makeClient({ issueResponse: makeIssueResponse({ isPr: true }) });
    await hydrateContext(client, comment);
    expect(client.request).toHaveBeenCalledWith(`${BASE}/repos/owner/repo/pulls/1`);
  });

  it("fetches reviews from pulls/{number}/reviews", async () => {
    const comment = makeIssueComment(1);
    const client = makeClient({ issueResponse: makeIssueResponse({ isPr: true }) });
    await hydrateContext(client, comment);
    expect(client.paginateAll).toHaveBeenCalledWith(`${BASE}/repos/owner/repo/pulls/1/reviews`);
  });

  it("handles null review body and author", async () => {
    const nullReview = [{ id: 2001, user: null, state: "COMMENTED", body: null, submitted_at: null }];
    const client = makeClient({
      issueResponse: makeIssueResponse({ isPr: true }),
      reviews: nullReview,
    });
    const ctx = await hydrateContext(client, makeIssueComment(1));
    if (ctx.kind !== "pull_request") throw new Error("Expected pull_request");
    expect(ctx.reviews[0]).toMatchObject({ author: null, body: null, submittedAt: null });
  });
});

describe("hydrateContext() — PullRequestReviewComment", () => {
  it("returns kind: pull_request", async () => {
    const client = makeClient({});
    const ctx = await hydrateContext(client, makePrReviewComment(2));
    expect(ctx.kind).toBe("pull_request");
  });

  it("populates owner, repo, number from pull_request_url", async () => {
    const client = makeClient({});
    const ctx = await hydrateContext(client, makePrReviewComment(7));
    expect(ctx.owner).toBe("owner");
    expect(ctx.repo).toBe("repo");
    expect(ctx.number).toBe(7);
  });

  it("fetches issue details from /issues/{number} derived from pull_request_url", async () => {
    const comment = makePrReviewComment(2);
    const client = makeClient({});
    await hydrateContext(client, comment);
    expect(client.request).toHaveBeenCalledWith(`${BASE}/repos/owner/repo/issues/2`);
  });

  it("fetches PR details from pull_request_url", async () => {
    const comment = makePrReviewComment(2);
    const client = makeClient({});
    await hydrateContext(client, comment);
    expect(client.request).toHaveBeenCalledWith(comment.pull_request_url);
  });

  it("does not fetch thread comments", async () => {
    const comment = makePrReviewComment(2);
    const client = makeClient({});
    await hydrateContext(client, comment);
    const paginateCalls = (client.paginateAll as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(paginateCalls.every(([url]) => !url.endsWith("/comments"))).toBe(true);
  });

  it("fetches reviews from pull_request_url/reviews", async () => {
    const comment = makePrReviewComment(2);
    const client = makeClient({});
    await hydrateContext(client, comment);
    expect(client.paginateAll).toHaveBeenCalledWith(`${BASE}/repos/owner/repo/pulls/2/reviews`);
  });

  it("includes pullRequest branch refs", async () => {
    const client = makeClient({ pullResponse: makePullResponse("develop", "hotfix") });
    const ctx = await hydrateContext(client, makePrReviewComment(2));
    if (ctx.kind !== "pull_request") throw new Error("Expected pull_request");
    expect(ctx.pullRequest.baseBranch).toBe("develop");
    expect(ctx.pullRequest.headBranch).toBe("hotfix");
  });
});
