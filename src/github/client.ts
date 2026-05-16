import {
  AuthError,
  GitHubError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  SecondaryRateLimitError,
} from "./errors.js";

const OTTO_VERSION = "0.1.0";

type RequestOptions = {
  method?: string;
  params?: Record<string, string>;
  body?: unknown;
};

function parseNextLink(linkHeader: string): string | undefined {
  for (const part of linkHeader.split(",")) {
    const match = /^<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function classifyError(status: number, headers: Headers, message: string): GitHubError | NetworkError {
  if (status === 429) {
    const reset = headers.get("x-ratelimit-reset");
    const resetAt = reset !== null ? new Date(Number(reset) * 1000) : new Date();
    return new RateLimitError(`Rate limit exceeded: ${message}`, status, resetAt);
  }

  if (status === 403) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
      return new SecondaryRateLimitError(
        `Secondary rate limit: ${message}`,
        Number(retryAfter),
      );
    }
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = headers.get("x-ratelimit-reset");
      const resetAt = reset !== null ? new Date(Number(reset) * 1000) : new Date();
      return new RateLimitError(`Rate limit exceeded: ${message}`, status, resetAt);
    }
    return new AuthError(`Forbidden: ${message}`, status);
  }

  if (status === 401) {
    return new AuthError(`Unauthorized: ${message}`, status);
  }

  if (status === 404) {
    return new NotFoundError(message);
  }

  return new GitHubError(message, status);
}

export class GitHubClient {
  readonly #token: string;
  readonly #baseUrl: string;

  constructor(token: string, baseUrl = "https://api.github.com") {
    this.#token = token;
    this.#baseUrl = baseUrl;
  }

  async request<T>(path: string, options?: RequestOptions): Promise<T> {
    const url = new URL(
      path.startsWith("http") ? path : `${this.#baseUrl}${path}`,
    );
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `otto/${OTTO_VERSION}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: options?.method ?? "GET",
        headers,
        ...(options?.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch (err) {
      throw new NetworkError(`Network error: ${String(err)}`, { cause: err });
    }

    if (!response.ok) {
      let message = `HTTP ${String(response.status)}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (typeof body.message === "string") message = body.message;
      } catch {
        // ignore parse failure; use default message
      }
      throw classifyError(response.status, response.headers, message);
    }

    return response.json() as Promise<T>;
  }

  async *paginate<T>(
    path: string,
    params?: Record<string, string>,
  ): AsyncGenerator<T, void, undefined> {
    let nextUrl: string | undefined = path;
    let isFirst = true;

    while (nextUrl !== undefined) {
      const url = new URL(
        nextUrl.startsWith("http") ? nextUrl : `${this.#baseUrl}${nextUrl}`,
      );
      if (isFirst && params) {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
        isFirst = false;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": `otto/${OTTO_VERSION}`,
        "X-GitHub-Api-Version": "2022-11-28",
      };

      let response: Response;
      try {
        response = await fetch(url.toString(), { headers });
      } catch (err) {
        throw new NetworkError(`Network error: ${String(err)}`, { cause: err });
      }

      if (!response.ok) {
        let message = `HTTP ${String(response.status)}`;
        try {
          const body = (await response.json()) as { message?: string };
          if (typeof body.message === "string") message = body.message;
        } catch {
          // ignore
        }
        throw classifyError(response.status, response.headers, message);
      }

      const items = (await response.json()) as T[];
      for (const item of items) {
        yield item;
      }

      const linkHeader = response.headers.get("link");
      nextUrl =
        linkHeader !== null ? parseNextLink(linkHeader) : undefined;
    }
  }

  async paginateAll<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this.paginate<T>(path, params)) {
      results.push(item);
    }
    return results;
  }
}
