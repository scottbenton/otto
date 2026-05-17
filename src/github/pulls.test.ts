import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubClient } from "./client.js";
import { createPrForIssueTask } from "./pulls.js";

type MockResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function mockFetch(responses: MockResponse[]) {
  let call = 0;
  return vi.fn(() => {
    const resp = responses[call++];
    if (resp === undefined) throw new Error("Unexpected fetch call");
    return Promise.resolve(
      new Response(resp.body !== undefined ? JSON.stringify(resp.body) : null, {
        status: resp.status,
        headers: { "content-type": "application/json", ...resp.headers },
      }),
    );
  });
}

const DEFAULT_INPUT = {
  owner: "owner",
  repo: "repo",
  issueNumber: 7,
  issueTitle: "Fix the bug",
  branch: "otto/issue-7",
} as const;

const REPO_RESPONSE = { status: 200, body: { default_branch: "main" } };
const PR_RESPONSE = {
  status: 201,
  body: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
};

describe("createPrForIssueTask", () => {
  let client: GitHubClient;

  beforeEach(() => {
    client = new GitHubClient("ghp_test", "https://api.github.test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the PR number and URL", async () => {
    vi.stubGlobal("fetch", mockFetch([REPO_RESPONSE, PR_RESPONSE]));

    const result = await createPrForIssueTask(client, DEFAULT_INPUT);

    expect(result).toEqual({ number: 42, htmlUrl: "https://github.com/owner/repo/pull/42" });
  });

  it("sends POST to the pulls endpoint", async () => {
    const fake = mockFetch([REPO_RESPONSE, PR_RESPONSE]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [url, init] = fake.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain("/repos/owner/repo/pulls");
    expect(init.method).toBe("POST");
  });

  it("uses the issue title as PR title", async () => {
    const fake = mockFetch([REPO_RESPONSE, PR_RESPONSE]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [, init] = fake.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.title).toBe("Fix the bug");
  });

  it("includes Closes link in PR body", async () => {
    const fake = mockFetch([REPO_RESPONSE, PR_RESPONSE]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [, init] = fake.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.body).toBe("Closes #7");
  });

  it("sets head to the pushed branch", async () => {
    const fake = mockFetch([REPO_RESPONSE, PR_RESPONSE]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [, init] = fake.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.head).toBe("otto/issue-7");
  });

  it("uses the repo default branch as base", async () => {
    const fake = mockFetch([
      { status: 200, body: { default_branch: "develop" } },
      PR_RESPONSE,
    ]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [, init] = fake.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.base).toBe("develop");
  });

  it("fetches repo info before creating the PR", async () => {
    const fake = mockFetch([REPO_RESPONSE, PR_RESPONSE]);
    vi.stubGlobal("fetch", fake);

    await createPrForIssueTask(client, DEFAULT_INPUT);

    const [repoUrl] = fake.mock.calls[0] as unknown as [string];
    expect(repoUrl).toContain("/repos/owner/repo");
    expect(fake).toHaveBeenCalledTimes(2);
  });
});
