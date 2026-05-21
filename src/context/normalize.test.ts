import { describe, expect, it } from "vitest";

import type {
  IssueContext,
  IssueDetails,
  PullRequestContext,
  PullRequestDetails,
  PullRequestLineContext,
  PullRequestReview,
  ThreadComment
} from "./types.js";
import { normalizeContext } from "./normalize.js";

const ISSUE: IssueDetails = {
  number: 1,
  title: "Fix the bug",
  body: "It is broken",
  state: "open",
  author: "alice",
  labels: ["bug"]
};

const PR_DETAILS: PullRequestDetails = {
  htmlUrl: "https://github.com/owner/repo/pull/2",
  baseBranch: "main",
  headBranch: "fix-branch",
  headSha: "abc123"
};

const REVIEW: PullRequestReview = {
  id: 9,
  author: "carol",
  state: "APPROVED",
  body: null,
  submittedAt: "2024-01-02T00:00:00Z"
};

const COMMENT: ThreadComment = {
  id: 42,
  author: "bob",
  body: "looks good",
  createdAt: "2024-01-01T00:00:00Z"
};

const LINE_CONTEXT_CURRENT: PullRequestLineContext = {
  outdated: false,
  id: 100,
  path: "src/foo.ts",
  patch: "@@ -1,3 +1,4 @@",
  position: 5,
  currentFile: { path: "src/foo.ts", ref: "abc123", content: "export const x = 1;" }
};

const LINE_CONTEXT_OUTDATED: PullRequestLineContext = {
  outdated: true,
  id: 101,
  path: "src/bar.ts",
  patch: null,
  position: null,
  clarifyMessage: "This comment is outdated."
};

function makeIssueContext(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    kind: "issue",
    owner: "owner",
    repo: "repo",
    number: 1,
    issue: ISSUE,
    comments: [COMMENT],
    truncated: false,
    ...overrides
  };
}

function makePrContext(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    kind: "pull_request",
    owner: "owner",
    repo: "repo",
    number: 2,
    issue: ISSUE,
    pullRequest: PR_DETAILS,
    reviews: [REVIEW],
    inlineThread: [COMMENT],
    lineComments: [],
    ...overrides
  };
}

describe("normalizeContext() — IssueContext", () => {
  it("sets sourceType to issue_comment", () => {
    expect(normalizeContext(makeIssueContext()).sourceType).toBe("issue_comment");
  });

  it("passes through owner, repo, number", () => {
    const result = normalizeContext(makeIssueContext({ owner: "acme", repo: "widget", number: 7 }));
    expect(result.owner).toBe("acme");
    expect(result.repo).toBe("widget");
    expect(result.number).toBe(7);
  });

  it("passes through issue details", () => {
    expect(normalizeContext(makeIssueContext()).issue).toEqual(ISSUE);
  });

  it("sets pullRequest to null", () => {
    expect(normalizeContext(makeIssueContext()).pullRequest).toBeNull();
  });

  it("sets reviews to empty array", () => {
    expect(normalizeContext(makeIssueContext()).reviews).toEqual([]);
  });

  it("maps comments from IssueContext.comments", () => {
    const ctx = makeIssueContext({ comments: [COMMENT] });
    expect(normalizeContext(ctx).comments).toEqual([COMMENT]);
  });

  it("passes through truncated flag", () => {
    expect(normalizeContext(makeIssueContext({ truncated: true })).truncated).toBe(true);
    expect(normalizeContext(makeIssueContext({ truncated: false })).truncated).toBe(false);
  });

  it("sets lineContexts to empty array", () => {
    expect(normalizeContext(makeIssueContext()).lineContexts).toEqual([]);
  });
});

describe("normalizeContext() — PullRequestContext (conversation comment, no lineComment)", () => {
  it("sets sourceType to pr_conversation_comment when no lineComment", () => {
    expect(normalizeContext(makePrContext()).sourceType).toBe("pr_conversation_comment");
  });

  it("passes through owner, repo, number", () => {
    const result = normalizeContext(makePrContext({ owner: "acme", repo: "api", number: 99 }));
    expect(result.owner).toBe("acme");
    expect(result.repo).toBe("api");
    expect(result.number).toBe(99);
  });

  it("passes through pullRequest details", () => {
    expect(normalizeContext(makePrContext()).pullRequest).toEqual(PR_DETAILS);
  });

  it("passes through reviews", () => {
    expect(normalizeContext(makePrContext()).reviews).toEqual([REVIEW]);
  });

  it("maps comments from inlineThread", () => {
    const ctx = makePrContext({ inlineThread: [COMMENT] });
    expect(normalizeContext(ctx).comments).toEqual([COMMENT]);
  });

  it("sets truncated to false", () => {
    expect(normalizeContext(makePrContext()).truncated).toBe(false);
  });

  it("sets lineContexts to empty array", () => {
    expect(normalizeContext(makePrContext()).lineContexts).toEqual([]);
  });
});

describe("normalizeContext() — PullRequestContext (line comment, with lineComment)", () => {
  it("sets sourceType to pr_line_comment when lineComment is present", () => {
    const ctx = makePrContext({ lineComments: [LINE_CONTEXT_CURRENT] });
    expect(normalizeContext(ctx).sourceType).toBe("pr_line_comment");
  });

  it("sets lineContexts from lineComments", () => {
    const ctx = makePrContext({ lineComments: [LINE_CONTEXT_CURRENT] });
    expect(normalizeContext(ctx).lineContexts).toEqual([LINE_CONTEXT_CURRENT]);
  });

  it("passes through outdated lineComments", () => {
    const ctx = makePrContext({ lineComments: [LINE_CONTEXT_OUTDATED] });
    const result = normalizeContext(ctx);
    expect(result.sourceType).toBe("pr_line_comment");
    expect(result.lineContexts).toEqual([LINE_CONTEXT_OUTDATED]);
  });

  it("still sets truncated to false", () => {
    const ctx = makePrContext({ lineComments: [LINE_CONTEXT_CURRENT] });
    expect(normalizeContext(ctx).truncated).toBe(false);
  });

  it("still passes through reviews", () => {
    const ctx = makePrContext({ lineComments: [LINE_CONTEXT_CURRENT], reviews: [REVIEW] });
    expect(normalizeContext(ctx).reviews).toEqual([REVIEW]);
  });
});
