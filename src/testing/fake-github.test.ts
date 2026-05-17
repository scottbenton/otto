import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitHubClient } from "../github/client.js";
import { FakeGitHubServer } from "./fake-github.js";

describe("FakeGitHubServer", () => {
  let server: FakeGitHubServer;
  let client: GitHubClient;

  beforeEach(async () => {
    server = new FakeGitHubServer({ authenticatedUser: "test-user" });
    await server.start();
    client = new GitHubClient("ghp_fake", server.baseUrl);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("starts on a random port and provides a baseUrl", () => {
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  describe("GET /user", () => {
    it("returns the seeded authenticated user", async () => {
      const result = await client.request<{ login: string }>("/user");
      expect(result.login).toBe("test-user");
    });
  });

  describe("GET /repos/:owner/:repo", () => {
    it("returns repo info including default branch", async () => {
      server.seedRepo("owner", "repo", { defaultBranch: "develop" });
      const result = await client.request<{ default_branch: string }>("/repos/owner/repo");
      expect(result.default_branch).toBe("develop");
    });

    it("defaults to main when no defaultBranch is specified", async () => {
      server.seedRepo("owner", "repo");
      const result = await client.request<{ default_branch: string }>("/repos/owner/repo");
      expect(result.default_branch).toBe("main");
    });

    it("returns 404 for an unseeded repo", async () => {
      await expect(client.request("/repos/ghost/repo")).rejects.toThrow();
    });
  });

  describe("GET /repos/:owner/:repo/issues/comments", () => {
    beforeEach(() => {
      server.seedRepo("owner", "repo");
      server.addIssueComment("owner", "repo", {
        id: 1,
        url: `${server.baseUrl}/repos/owner/repo/issues/comments/1`,
        body: "otto fix this",
        user: { login: "alice" },
        created_at: "2024-01-01T12:00:00Z",
        updated_at: "2024-01-01T12:00:00Z",
        issue_url: server.issueUrl("owner", "repo", 10),
        html_url: `${server.baseUrl}/owner/repo/issues/10#issuecomment-1`,
      });
    });

    it("returns all seeded issue comments", async () => {
      const comments = await client.paginateAll<{ id: number }>("/repos/owner/repo/issues/comments");
      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe(1);
    });

    it("filters by since — excludes comments at or before the cutoff", async () => {
      const comments = await client.paginateAll<{ id: number }>(
        "/repos/owner/repo/issues/comments",
        { since: "2024-01-02T00:00:00Z" },
      );
      expect(comments).toHaveLength(0);
    });

    it("filters by since — includes comments after the cutoff", async () => {
      const comments = await client.paginateAll<{ id: number }>(
        "/repos/owner/repo/issues/comments",
        { since: "2024-01-01T00:00:00Z" },
      );
      expect(comments).toHaveLength(1);
    });
  });

  describe("GET /repos/:owner/:repo/pulls/comments", () => {
    it("returns seeded PR review comments", async () => {
      server.seedRepo("owner", "repo");
      server.addPRReviewComment("owner", "repo", {
        id: 5,
        url: `${server.baseUrl}/repos/owner/repo/pulls/comments/5`,
        body: "otto apply this suggestion",
        user: { login: "bob" },
        created_at: "2024-02-01T00:00:00Z",
        updated_at: "2024-02-01T00:00:00Z",
        pull_request_url: server.pullUrl("owner", "repo", 3),
        html_url: `${server.baseUrl}/owner/repo/pull/3#pullrequestreviewcomment-5`,
      });

      const comments = await client.paginateAll<{ id: number }>("/repos/owner/repo/pulls/comments");
      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe(5);
    });
  });

  describe("GET /repos/:owner/:repo/issues/:number/comments", () => {
    it("returns only comments for that specific issue", async () => {
      server.seedRepo("owner", "repo");
      server.addIssueComment("owner", "repo", {
        id: 10,
        url: `${server.baseUrl}/repos/owner/repo/issues/comments/10`,
        body: "comment on issue 1",
        user: { login: "alice" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        issue_url: server.issueUrl("owner", "repo", 1),
        html_url: `${server.baseUrl}/owner/repo/issues/1#issuecomment-10`,
      });
      server.addIssueComment("owner", "repo", {
        id: 11,
        url: `${server.baseUrl}/repos/owner/repo/issues/comments/11`,
        body: "comment on issue 2",
        user: { login: "alice" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        issue_url: server.issueUrl("owner", "repo", 2),
        html_url: `${server.baseUrl}/owner/repo/issues/2#issuecomment-11`,
      });

      const comments = await client.paginateAll<{ id: number; body: string }>(
        "/repos/owner/repo/issues/1/comments",
      );
      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe(10);
    });
  });

  describe("POST /repos/:owner/:repo/issues/:number/comments", () => {
    beforeEach(() => {
      server.seedRepo("owner", "repo");
    });

    it("creates a comment and returns it with an id", async () => {
      const result = await client.request<{ id: number; body: string }>(
        "/repos/owner/repo/issues/7/comments",
        { method: "POST", body: { body: "<!-- otto:v1 status --> Status: running" } },
      );
      expect(result.id).toBeTypeOf("number");
      expect(result.body).toBe("<!-- otto:v1 status --> Status: running");
    });

    it("created comment appears in subsequent repo-wide listing", async () => {
      await client.request("/repos/owner/repo/issues/7/comments", {
        method: "POST",
        body: { body: "hello" },
      });
      const all = await client.paginateAll<{ id: number }>("/repos/owner/repo/issues/comments");
      expect(all).toHaveLength(1);
    });

    it("sets issue_url based on the issue number in the path", async () => {
      const result = await client.request<{ issue_url: string }>(
        "/repos/owner/repo/issues/42/comments",
        { method: "POST", body: { body: "x" } },
      );
      expect(result.issue_url).toContain("/issues/42");
    });
  });

  describe("PATCH /repos/:owner/:repo/issues/comments/:id", () => {
    beforeEach(() => {
      server.seedRepo("owner", "repo");
      server.addIssueComment("owner", "repo", {
        id: 42,
        url: `${server.baseUrl}/repos/owner/repo/issues/comments/42`,
        body: "original body",
        user: { login: "otto-user" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        issue_url: server.issueUrl("owner", "repo", 5),
        html_url: `${server.baseUrl}/owner/repo/issues/5#issuecomment-42`,
      });
    });

    it("updates the comment body and returns the updated comment", async () => {
      const result = await client.request<{ id: number; body: string }>(
        "/repos/owner/repo/issues/comments/42",
        { method: "PATCH", body: { body: "Status: completed" } },
      );
      expect(result.id).toBe(42);
      expect(result.body).toBe("Status: completed");
    });

    it("mutation is visible in subsequent reads", async () => {
      await client.request("/repos/owner/repo/issues/comments/42", {
        method: "PATCH",
        body: { body: "Status: completed" },
      });
      const all = await client.paginateAll<{ id: number; body: string }>(
        "/repos/owner/repo/issues/comments",
      );
      expect(all[0]?.body).toBe("Status: completed");
    });
  });

  describe("PATCH /repos/:owner/:repo/pulls/comments/:id", () => {
    it("updates a PR review comment body", async () => {
      server.seedRepo("owner", "repo");
      server.addPRReviewComment("owner", "repo", {
        id: 99,
        url: `${server.baseUrl}/repos/owner/repo/pulls/comments/99`,
        body: "original",
        user: { login: "otto-user" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        pull_request_url: server.pullUrl("owner", "repo", 3),
        html_url: `${server.baseUrl}/owner/repo/pull/3#pullrequestreviewcomment-99`,
      });

      const result = await client.request<{ body: string }>(
        "/repos/owner/repo/pulls/comments/99",
        { method: "PATCH", body: { body: "Status: failed" } },
      );
      expect(result.body).toBe("Status: failed");
    });
  });

  describe("GET /repos/:owner/:repo/issues/:number", () => {
    it("returns the seeded issue", async () => {
      server.seedRepo("owner", "repo");
      server.addIssue("owner", "repo", {
        number: 5,
        title: "Fix the bug",
        body: "It is broken",
        state: "open",
        user: { login: "alice" },
        labels: [{ name: "bug" }],
      });

      const result = await client.request<{ number: number; title: string }>(
        "/repos/owner/repo/issues/5",
      );
      expect(result.number).toBe(5);
      expect(result.title).toBe("Fix the bug");
    });
  });

  describe("GET /repos/:owner/:repo/pulls/:number", () => {
    it("returns the seeded PR", async () => {
      server.seedRepo("owner", "repo");
      server.addPR("owner", "repo", {
        number: 3,
        title: "My PR",
        body: null,
        state: "open",
        html_url: `${server.baseUrl}/owner/repo/pull/3`,
        user: { login: "alice" },
        labels: [],
        base: { ref: "main" },
        head: { ref: "feature", sha: "abc123" },
      });

      const result = await client.request<{ number: number; base: { ref: string } }>(
        "/repos/owner/repo/pulls/3",
      );
      expect(result.number).toBe(3);
      expect(result.base.ref).toBe("main");
    });
  });

  describe("GET /repos/:owner/:repo/pulls/:number/reviews", () => {
    it("returns seeded reviews", async () => {
      server.seedRepo("owner", "repo");
      server.addPRReviews("owner", "repo", 3, [
        { id: 1, user: { login: "reviewer" }, state: "APPROVED", body: "lgtm", submitted_at: "2024-01-01T00:00:00Z" },
      ]);

      const reviews = await client.paginateAll<{ state: string }>("/repos/owner/repo/pulls/3/reviews");
      expect(reviews).toHaveLength(1);
      expect(reviews.at(0)?.state).toBe("APPROVED");
    });

    it("returns empty array for a PR with no seeded reviews", async () => {
      server.seedRepo("owner", "repo");
      const reviews = await client.paginateAll("/repos/owner/repo/pulls/99/reviews");
      expect(reviews).toHaveLength(0);
    });
  });

  describe("POST /repos/:owner/:repo/pulls", () => {
    it("creates a PR and returns it with a number and html_url", async () => {
      server.seedRepo("owner", "repo");
      const result = await client.request<{ number: number; html_url: string; base: { ref: string } }>(
        "/repos/owner/repo/pulls",
        {
          method: "POST",
          body: { title: "Fix issue #5", body: "Closes #5", head: "otto-branch", base: "main" },
        },
      );
      expect(result.number).toBeTypeOf("number");
      expect(result.html_url).toContain("/pull/");
      expect(result.base.ref).toBe("main");
    });
  });

  describe("GET /repos/:owner/:repo/contents/:path", () => {
    it("returns seeded file content", async () => {
      server.seedRepo("owner", "repo");
      server.addFileContent("owner", "repo", "src/index.ts", {
        type: "file",
        encoding: "base64",
        content: Buffer.from("export {};").toString("base64"),
      });

      const result = await client.request<{ type: string; content: string }>(
        "/repos/owner/repo/contents/src/index.ts",
      );
      expect(result.type).toBe("file");
      expect(Buffer.from(result.content, "base64").toString()).toBe("export {};");
    });
  });

  describe("requests recording", () => {
    it("records every request's method, path, and query", async () => {
      server.seedRepo("owner", "repo");
      await client.request("/repos/owner/repo/issues/comments", {
        params: { since: "2024-01-01T00:00:00Z" },
      });

      expect(server.requests).toHaveLength(1);
      const req = server.requests.at(0);
      expect(req?.method).toBe("GET");
      expect(req?.path).toBe("/repos/owner/repo/issues/comments");
      expect(req?.query.get("since")).toBe("2024-01-01T00:00:00Z");
    });

    it("records the body of POST requests", async () => {
      server.seedRepo("owner", "repo");
      await client.request("/repos/owner/repo/issues/1/comments", {
        method: "POST",
        body: { body: "hello" },
      });

      const req = server.requests.at(0);
      expect(req?.method).toBe("POST");
      expect((req?.body as { body: string } | undefined)?.body).toBe("hello");
    });
  });

  describe("helper URLs", () => {
    it("issueUrl() returns the correct full URL for an issue", () => {
      server.seedRepo("owner", "repo");
      expect(server.issueUrl("owner", "repo", 5)).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/repos\/owner\/repo\/issues\/5$/,
      );
    });

    it("pullUrl() returns the correct full URL for a PR", () => {
      server.seedRepo("owner", "repo");
      expect(server.pullUrl("owner", "repo", 3)).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/repos\/owner\/repo\/pulls\/3$/,
      );
    });
  });
});
