import {
  AuthError,
  GitHubError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  SecondaryRateLimitError,
} from "./errors.js";

const OTTO_VERSION = "0.1.0";

// GitHub's stable REST API version (date-based identifier, not a year-old snapshot)
const GITHUB_API_VERSION = "2022-11-28";

type RequestOptions = {
  method?: string;
  params?: Record<string, string>;
  body?: unknown;
};

type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
};

type RequiredRetryOptions = Required<RetryOptions>;

const DEFAULT_RETRY_OPTIONS: RequiredRetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random,
};

function parseNextLink(linkHeader: string): string | undefined {
  for (const part of linkHeader.split(",")) {
    const match = /^<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function classifyError(
  status: number,
  headers: Headers,
  message: string,
): GitHubError | NetworkError {
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

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string") return body.message;
  } catch {
    // ignore parse failure
  }
  return `HTTP ${String(response.status)}`;
}

function clampDelay(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

function delayForRetry(
  error: GitHubError | NetworkError,
  retryCount: number,
  retryOptions: RequiredRetryOptions,
): number | undefined {
  if (error instanceof RateLimitError) {
    return clampDelay(error.resetAt.getTime() - Date.now());
  }

  if (error instanceof SecondaryRateLimitError) {
    return clampDelay(error.retryAfterSeconds * 1_000);
  }

  if (error instanceof GitHubError && error.statusCode >= 500) {
    const exponentialDelay = retryOptions.baseDelayMs * 2 ** retryCount;
    return clampDelay(
      exponentialDelay + retryOptions.random() * retryOptions.baseDelayMs,
    );
  }

  return undefined;
}

export class GitHubClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #retryOptions: RequiredRetryOptions;

  constructor(
    token: string,
    baseUrl = "https://api.github.com",
    retryOptions?: RetryOptions,
  ) {
    this.#token = token;
    this.#baseUrl = baseUrl;
    this.#retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  #buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `otto/${OTTO_VERSION}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }

  #resolveUrl(path: string): URL {
    return new URL(path.startsWith("http") ? path : `${this.#baseUrl}${path}`);
  }

  async #fetchWithRetry(url: URL, init?: RequestInit): Promise<Response> {
    for (let retryCount = 0; ; retryCount++) {
      let response: Response;
      try {
        response = await fetch(url.toString(), init);
      } catch (err) {
        throw new NetworkError(`Network error: ${String(err)}`, { cause: err });
      }

      if (response.ok) return response;

      const message = await extractErrorMessage(response);
      const error = classifyError(response.status, response.headers, message);
      const delayMs = delayForRetry(error, retryCount, this.#retryOptions);

      if (
        delayMs === undefined ||
        retryCount >= this.#retryOptions.maxRetries
      ) {
        throw error;
      }

      await this.#retryOptions.sleep(delayMs);
    }
  }

  async request<T>(path: string, options?: RequestOptions): Promise<T> {
    const url = this.#resolveUrl(path);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.#fetchWithRetry(url, {
      method: options?.method ?? "GET",
      headers: this.#buildHeaders(),
      ...(options?.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });

    return response.json() as Promise<T>;
  }

  async *paginate<T>(
    path: string,
    params?: Record<string, string>,
  ): AsyncGenerator<T, void, undefined> {
    let nextUrl: string | undefined = path;
    let isFirst = true;

    while (nextUrl !== undefined) {
      const url = this.#resolveUrl(nextUrl);
      if (isFirst && params) {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
        isFirst = false;
      }

      const response = await this.#fetchWithRetry(url, {
        headers: this.#buildHeaders(),
      });

      const items = (await response.json()) as T[];
      for (const item of items) {
        yield item;
      }

      const linkHeader = response.headers.get("link");
      nextUrl = linkHeader !== null ? parseNextLink(linkHeader) : undefined;
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
