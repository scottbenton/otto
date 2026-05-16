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

  beforeEach(() => {
    client = new GitHubClient("ghp_test", "https://api.github.test");
  });

  afterEach(() => {
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
