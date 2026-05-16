import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubClient } from "./client.js";
import { resolveAuthenticatedUser } from "./auth.js";

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
      new Response(
        resp.body !== undefined ? JSON.stringify(resp.body) : null,
        {
          status: resp.status,
          headers: { "content-type": "application/json", ...resp.headers },
        },
      ),
    );
  });
}

describe("resolveAuthenticatedUser()", () => {
  const client = new GitHubClient("ghp_test", "https://api.github.test");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the authenticated user login", async () => {
    vi.stubGlobal("fetch", mockFetch([{ status: 200, body: { login: "alice", id: 1 } }]));
    const login = await resolveAuthenticatedUser(client);
    expect(login).toBe("alice");
  });

  it("throws a descriptive error on 401 (invalid token)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ status: 401, body: { message: "Bad credentials" } }]),
    );
    await expect(resolveAuthenticatedUser(client)).rejects.toThrow(
      /GitHub authentication failed/,
    );
  });

  it("throws a descriptive error on 403 (insufficient scopes)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ status: 403, body: { message: "Resource not accessible by personal access token" } }]),
    );
    await expect(resolveAuthenticatedUser(client)).rejects.toThrow(
      /GitHub authentication failed/,
    );
  });

  it("re-throws network errors unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(resolveAuthenticatedUser(client)).rejects.toThrow("ECONNREFUSED");
  });
});
