import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  GitHubClient,
  NetworkError,
  NotFoundError,
  RateLimitError,
  SecondaryRateLimitError,
} from "./index.js";

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
          headers: {
            "content-type": "application/json",
            ...resp.headers,
          },
        },
      ),
    );
  });
}

describe("GitHubClient", () => {
  let client: GitHubClient;
  const retryOptions = {
    sleep: vi.fn<(_: number) => Promise<void>>().mockResolvedValue(undefined),
    random: vi.fn<() => number>().mockReturnValue(0),
  };

  beforeEach(() => {
    client = new GitHubClient("ghp_test", "https://api.github.test");
    retryOptions.sleep.mockClear();
    retryOptions.random.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("request()", () => {
    it("sends Authorization Bearer header", async () => {
      const fake = mockFetch([{ status: 200, body: { id: 1 } }]);
      vi.stubGlobal("fetch", fake);

      await client.request<{ id: number }>("/user");

      const [, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer ghp_test",
      );
    });

    it("sends Accept and User-Agent headers", async () => {
      const fake = mockFetch([{ status: 200, body: {} }]);
      vi.stubGlobal("fetch", fake);

      await client.request("/user");

      const [, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
      const h = init.headers as Record<string, string>;
      expect(h.Accept).toBe("application/vnd.github+json");
      expect(h["User-Agent"]).toMatch(/^otto\//);
    });

    it("appends query params to the URL", async () => {
      const fake = mockFetch([{ status: 200, body: [] }]);
      vi.stubGlobal("fetch", fake);

      await client.request("/issues/comments", { params: { since: "2024-01-01T00:00:00Z" } });

      const [url] = fake.mock.calls[0] as unknown as [string];
      expect(url).toContain("since=2024-01-01T00%3A00%3A00Z");
    });

    it("returns parsed JSON body", async () => {
      vi.stubGlobal("fetch", mockFetch([{ status: 200, body: { login: "alice" } }]));
      const result = await client.request<{ login: string }>("/user");
      expect(result).toEqual({ login: "alice" });
    });

    it("throws NetworkError on fetch failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      await expect(client.request("/user")).rejects.toThrow(NetworkError);
    });

    it("throws AuthError on 401", async () => {
      vi.stubGlobal("fetch", mockFetch([{ status: 401, body: { message: "Bad credentials" } }]));
      await expect(client.request("/user")).rejects.toThrow(AuthError);
    });

    it("throws AuthError on 403 with no special headers", async () => {
      vi.stubGlobal("fetch", mockFetch([{ status: 403, body: { message: "Forbidden" } }]));
      await expect(client.request("/user")).rejects.toThrow(AuthError);
    });

    it("throws NotFoundError on 404", async () => {
      vi.stubGlobal("fetch", mockFetch([{ status: 404, body: { message: "Not Found" } }]));
      await expect(client.request("/repos/a/b")).rejects.toThrow(NotFoundError);
    });

    it("throws RateLimitError on 429", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        maxRetries: 0,
      });
      vi.stubGlobal(
        "fetch",
        mockFetch([
          {
            status: 429,
            body: { message: "rate limit" },
            headers: { "x-ratelimit-reset": "1700000000" },
          },
        ]),
      );
      await expect(client.request("/user")).rejects.toThrow(RateLimitError);
    });

    it("throws RateLimitError on 403 with x-ratelimit-remaining: 0", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        maxRetries: 0,
      });
      vi.stubGlobal(
        "fetch",
        mockFetch([
          {
            status: 403,
            body: { message: "rate limit exceeded" },
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700000000",
            },
          },
        ]),
      );
      await expect(client.request("/user")).rejects.toThrow(RateLimitError);
    });

    it("throws SecondaryRateLimitError on 403 with retry-after", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        maxRetries: 0,
      });
      vi.stubGlobal(
        "fetch",
        mockFetch([
          {
            status: 403,
            body: { message: "secondary rate limit" },
            headers: { "retry-after": "60" },
          },
        ]),
      );
      const err = await client.request("/user").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecondaryRateLimitError);
      expect((err as SecondaryRateLimitError).retryAfterSeconds).toBe(60);
    });

    it("RateLimitError carries resetAt date", async () => {
      const reset = 1700000000;
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        maxRetries: 0,
      });
      vi.stubGlobal(
        "fetch",
        mockFetch([
          {
            status: 429,
            body: {},
            headers: { "x-ratelimit-reset": String(reset) },
          },
        ]),
      );
      const err = await client.request("/user").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).resetAt).toEqual(new Date(reset * 1000));
    });

    it("retries 5xx responses with exponential backoff and jitter", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
        baseDelayMs: 100,
      });
      const fake = mockFetch([
        { status: 500, body: { message: "server error" } },
        { status: 502, body: { message: "bad gateway" } },
        { status: 200, body: { login: "alice" } },
      ]);
      vi.stubGlobal("fetch", fake);

      const result = await client.request<{ login: string }>("/user");

      expect(result).toEqual({ login: "alice" });
      expect(fake).toHaveBeenCalledTimes(3);
      expect(retryOptions.sleep).toHaveBeenNthCalledWith(1, 100);
      expect(retryOptions.sleep).toHaveBeenNthCalledWith(2, 200);
    });

    it("retries primary rate limit responses until reset time", async () => {
      vi.useFakeTimers({
        now: new Date("2026-05-19T12:00:00Z"),
        shouldAdvanceTime: true,
      });
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
      });
      const reset = Math.floor(
        new Date("2026-05-19T12:00:03Z").getTime() / 1000,
      );
      const fake = mockFetch([
        {
          status: 429,
          body: { message: "rate limit" },
          headers: { "x-ratelimit-reset": String(reset) },
        },
        { status: 200, body: { login: "alice" } },
      ]);
      vi.stubGlobal("fetch", fake);

      const result = await client.request<{ login: string }>("/user");

      expect(result).toEqual({ login: "alice" });
      expect(retryOptions.sleep).toHaveBeenCalledWith(3_000);
    });

    it("retries secondary rate limit responses after retry-after seconds", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
      });
      const fake = mockFetch([
        {
          status: 403,
          body: { message: "secondary rate limit" },
          headers: { "retry-after": "2" },
        },
        { status: 200, body: { login: "alice" } },
      ]);
      vi.stubGlobal("fetch", fake);

      const result = await client.request<{ login: string }>("/user");

      expect(result).toEqual({ login: "alice" });
      expect(retryOptions.sleep).toHaveBeenCalledWith(2_000);
    });

    it("treats malformed retry delay headers as immediate retries", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
      });
      const fake = mockFetch([
        {
          status: 403,
          body: { message: "secondary rate limit" },
          headers: { "retry-after": "not-a-number" },
        },
        { status: 200, body: { login: "alice" } },
      ]);
      vi.stubGlobal("fetch", fake);

      const result = await client.request<{ login: string }>("/user");

      expect(result).toEqual({ login: "alice" });
      expect(retryOptions.sleep).toHaveBeenCalledWith(0);
    });

    it("does not retry AuthError or NotFoundError", async () => {
      const authFake = mockFetch([
        { status: 401, body: { message: "Bad credentials" } },
      ]);
      vi.stubGlobal("fetch", authFake);

      await expect(client.request("/user")).rejects.toThrow(AuthError);
      expect(authFake).toHaveBeenCalledTimes(1);

      const notFoundFake = mockFetch([
        { status: 404, body: { message: "Not Found" } },
      ]);
      vi.stubGlobal("fetch", notFoundFake);

      await expect(client.request("/repos/a/b")).rejects.toThrow(NotFoundError);
      expect(notFoundFake).toHaveBeenCalledTimes(1);
      expect(retryOptions.sleep).not.toHaveBeenCalled();
    });

    it("throws the final 5xx after max retries", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
        maxRetries: 2,
      });
      const fake = mockFetch([
        { status: 500, body: { message: "first" } },
        { status: 502, body: { message: "second" } },
        { status: 503, body: { message: "final" } },
      ]);
      vi.stubGlobal("fetch", fake);

      await expect(client.request("/user")).rejects.toThrow("final");
      expect(fake).toHaveBeenCalledTimes(3);
      expect(retryOptions.sleep).toHaveBeenCalledTimes(2);
    });
  });

  describe("paginate()", () => {
    it("yields all items from a single page", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch([{ status: 200, body: [{ id: 1 }, { id: 2 }] }]),
      );
      const items: { id: number }[] = [];
      for await (const item of client.paginate<{ id: number }>("/issues/comments")) {
        items.push(item);
      }
      expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("follows Link rel=next headers across pages", async () => {
      const fake = mockFetch([
        {
          status: 200,
          body: [{ id: 1 }],
          headers: {
            link: `<https://api.github.test/issues/comments?page=2>; rel="next"`,
          },
        },
        { status: 200, body: [{ id: 2 }] },
      ]);
      vi.stubGlobal("fetch", fake);

      const items: { id: number }[] = [];
      for await (const item of client.paginate<{ id: number }>("/issues/comments")) {
        items.push(item);
      }
      expect(items).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fake).toHaveBeenCalledTimes(2);
    });

    it("stops when there is no next link", async () => {
      const fake = mockFetch([{ status: 200, body: [{ id: 1 }] }]);
      vi.stubGlobal("fetch", fake);

      const items: { id: number }[] = [];
      for await (const item of client.paginate<{ id: number }>("/issues/comments")) {
        items.push(item);
      }
      expect(fake).toHaveBeenCalledTimes(1);
      expect(items).toHaveLength(1);
    });

    it("retries failed page fetches transparently", async () => {
      client = new GitHubClient("ghp_test", "https://api.github.test", {
        ...retryOptions,
      });
      const fake = mockFetch([
        { status: 500, body: { message: "server error" } },
        { status: 200, body: [{ id: 1 }] },
      ]);
      vi.stubGlobal("fetch", fake);

      const items: { id: number }[] = [];
      for await (const item of client.paginate<{ id: number }>("/issues/comments")) {
        items.push(item);
      }

      expect(items).toEqual([{ id: 1 }]);
      expect(fake).toHaveBeenCalledTimes(2);
      expect(retryOptions.sleep).toHaveBeenCalledTimes(1);
    });
  });

  describe("paginateAll()", () => {
    it("collects all pages into a single array", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch([
          {
            status: 200,
            body: [{ id: 1 }, { id: 2 }],
            headers: {
              link: `<https://api.github.test/issues/comments?page=2>; rel="next"`,
            },
          },
          { status: 200, body: [{ id: 3 }] },
        ]),
      );

      const items = await client.paginateAll<{ id: number }>("/issues/comments");
      expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });
});
