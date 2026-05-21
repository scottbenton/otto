import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};

export type FakeIssueComment = {
  id: number;
  url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  issue_url: string;
  html_url: string;
};

export type FakePRReviewComment = {
  id: number;
  url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  pull_request_url: string;
  html_url: string;
  in_reply_to_id?: number;
  path?: string;
  patch?: string | null;
  position?: number | null;
};

export type FakeIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: { name: string }[];
  pull_request?: { url: string };
};

export type FakePR = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  labels: { name: string }[];
  base: { ref: string };
  head: { ref: string; sha: string };
};

export type FakePRReview = {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
};

export type FakeFileContent = {
  type: string;
  encoding: string;
  content: string;
};

type RepoState = {
  defaultBranch: string;
  issueComments: FakeIssueComment[];
  prReviewComments: FakePRReviewComment[];
  issues: Map<number, FakeIssue>;
  prs: Map<number, FakePR>;
  prReviews: Map<number, FakePRReview[]>;
  prInlineComments: Map<number, FakePRReviewComment[]>;
  fileContents: Map<string, FakeFileContent>;
  nextCommentId: number;
};

type RouteResult = { status: number; body: unknown };

export class FakeGitHubServer {
  readonly #repos = new Map<string, RepoState>();
  #authenticatedUser: string;
  #server: Server;
  #port = 0;
  readonly #requests: RecordedRequest[] = [];

  constructor(options: { authenticatedUser?: string } = {}) {
    this.#authenticatedUser = options.authenticatedUser ?? "otto-user";
    this.#server = createServer((req, res) => {
      void this.#dispatch(req, res);
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  get requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  seedRepo(owner: string, repo: string, options: { defaultBranch?: string } = {}): void {
    const key = repoKey(owner, repo);
    if (!this.#repos.has(key)) {
      this.#repos.set(key, emptyRepo(options.defaultBranch ?? "main"));
    }
  }

  addIssueComment(owner: string, repo: string, comment: FakeIssueComment): void {
    this.#repo(owner, repo).issueComments.push(comment);
  }

  addPRReviewComment(owner: string, repo: string, comment: FakePRReviewComment): void {
    this.#repo(owner, repo).prReviewComments.push(comment);
  }

  addIssue(owner: string, repo: string, issue: FakeIssue): void {
    this.#repo(owner, repo).issues.set(issue.number, issue);
  }

  addPR(owner: string, repo: string, pr: FakePR): void {
    this.#repo(owner, repo).prs.set(pr.number, pr);
  }

  addPRReviews(owner: string, repo: string, prNumber: number, reviews: FakePRReview[]): void {
    this.#repo(owner, repo).prReviews.set(prNumber, reviews);
  }

  addPRInlineComments(
    owner: string,
    repo: string,
    prNumber: number,
    comments: FakePRReviewComment[],
  ): void {
    this.#repo(owner, repo).prInlineComments.set(prNumber, comments);
  }

  addFileContent(owner: string, repo: string, path: string, content: FakeFileContent): void {
    this.#repo(owner, repo).fileContents.set(path, content);
  }

  /** Convenience: build the full issue_url for a comment that targets a specific issue. */
  issueUrl(owner: string, repo: string, issueNumber: number): string {
    return `${this.baseUrl}/repos/${owner}/${repo}/issues/${String(issueNumber)}`;
  }

  /** Convenience: build the full pull_request_url for a comment that targets a specific PR. */
  pullUrl(owner: string, repo: string, prNumber: number): string {
    return `${this.baseUrl}/repos/${owner}/${repo}/pulls/${String(prNumber)}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const addr = this.#server.address() as { port: number };
    this.#port = addr.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => {
        if (err !== undefined) reject(err);
        else resolve();
      });
    });
  }

  #repo(owner: string, repo: string): RepoState {
    const state = this.#repos.get(repoKey(owner, repo));
    if (state === undefined) throw new Error(`Repo ${owner}/${repo} not seeded`);
    return state;
  }

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const query = url.searchParams;
    const method = req.method ?? "GET";
    const body = await readBody(req);

    this.#requests.push({ method, path, query, body });

    try {
      const result = this.#route(method, path, query, body);
      respond(res, result.status, result.body);
    } catch (err) {
      respond(res, 500, { message: String(err) });
    }
  }

  #route(method: string, path: string, query: URLSearchParams, body: unknown): RouteResult {
    if (method === "GET" && path === "/user") {
      return { status: 200, body: { login: this.#authenticatedUser } };
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch === null) {
      return { status: 404, body: { message: "Not Found" } };
    }

    const owner = repoMatch[1] ?? "";
    const repo = repoMatch[2] ?? "";
    const rest = repoMatch[3] ?? "";
    const state = this.#repos.get(repoKey(owner, repo));

    if (state === undefined) {
      return { status: 404, body: { message: `Unknown repo ${owner}/${repo}` } };
    }

    return this.#routeRepo(method, owner, repo, rest, query, body, state);
  }

  #routeRepo(
    method: string,
    owner: string,
    repo: string,
    rest: string,
    query: URLSearchParams,
    body: unknown,
    state: RepoState,
  ): RouteResult {
    const base = this.baseUrl;

    // GET /repos/:owner/:repo
    if (rest === "" && method === "GET") {
      return {
        status: 200,
        body: { name: repo, owner: { login: owner }, default_branch: state.defaultBranch },
      };
    }

    // GET /repos/:owner/:repo/issues/comments  (repo-wide, with optional since)
    if (rest === "/issues/comments" && method === "GET") {
      return { status: 200, body: filterSince(state.issueComments, query.get("since")) };
    }

    // GET /repos/:owner/:repo/pulls/comments  (repo-wide, with optional since)
    if (rest === "/pulls/comments" && method === "GET") {
      return { status: 200, body: filterSince(state.prReviewComments, query.get("since")) };
    }

    // POST /repos/:owner/:repo/pulls  (create PR)
    if (rest === "/pulls" && method === "POST") {
      const b = body as { title?: string; body?: string | null; head?: string; base?: string };
      const prNumber = state.prs.size + 1;
      const pr: FakePR = {
        number: prNumber,
        title: b.title ?? "",
        body: b.body ?? null,
        state: "open",
        html_url: `${base}/${owner}/${repo}/pull/${String(prNumber)}`,
        user: { login: this.#authenticatedUser },
        labels: [],
        base: { ref: b.base ?? state.defaultBranch },
        head: { ref: b.head ?? "", sha: "" },
      };
      state.prs.set(prNumber, pr);
      return { status: 201, body: pr };
    }

    // PATCH /repos/:owner/:repo/issues/comments/:id
    const issueCommentIdMatch = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (issueCommentIdMatch !== null && method === "PATCH") {
      const id = Number(issueCommentIdMatch[1]);
      const comment = state.issueComments.find((c) => c.id === id);
      if (comment === undefined) return { status: 404, body: { message: "Comment not found" } };
      const b = body as { body?: string };
      if (b.body !== undefined) {
        comment.body = b.body;
        comment.updated_at = new Date().toISOString();
      }
      return { status: 200, body: comment };
    }

    // GET /repos/:owner/:repo/pulls/comments/:id
    const prCommentIdMatch = /^\/pulls\/comments\/(\d+)$/.exec(rest);
    if (prCommentIdMatch !== null && method === "GET") {
      const id = Number(prCommentIdMatch[1]);
      const comment = state.prReviewComments.find((c) => c.id === id);
      if (comment === undefined) return { status: 404, body: { message: "Comment not found" } };
      return { status: 200, body: comment };
    }

    // PATCH /repos/:owner/:repo/pulls/comments/:id
    if (prCommentIdMatch !== null && method === "PATCH") {
      const id = Number(prCommentIdMatch[1]);
      const comment = state.prReviewComments.find((c) => c.id === id);
      if (comment === undefined) return { status: 404, body: { message: "Comment not found" } };
      const b = body as { body?: string };
      if (b.body !== undefined) {
        comment.body = b.body;
        comment.updated_at = new Date().toISOString();
      }
      return { status: 200, body: comment };
    }

    // GET /repos/:owner/:repo/issues/:number
    const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
    if (issueMatch !== null && method === "GET") {
      const issue = state.issues.get(Number(issueMatch[1]));
      if (issue === undefined) return { status: 404, body: { message: "Issue not found" } };
      return { status: 200, body: issue };
    }

    // GET or POST /repos/:owner/:repo/issues/:number/comments
    const issueCommentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (issueCommentsMatch !== null) {
      const issueNumber = Number(issueCommentsMatch[1]);

      if (method === "GET") {
        const issueUrl = `${base}/repos/${owner}/${repo}/issues/${String(issueNumber)}`;
        return {
          status: 200,
          body: state.issueComments.filter((c) => c.issue_url === issueUrl),
        };
      }

      if (method === "POST") {
        const b = body as { body?: string };
        const id = state.nextCommentId++;
        const now = new Date().toISOString();
        const comment: FakeIssueComment = {
          id,
          url: `${base}/repos/${owner}/${repo}/issues/comments/${String(id)}`,
          body: b.body ?? "",
          user: { login: this.#authenticatedUser },
          created_at: now,
          updated_at: now,
          issue_url: `${base}/repos/${owner}/${repo}/issues/${String(issueNumber)}`,
          html_url: `${base}/${owner}/${repo}/issues/${String(issueNumber)}#issuecomment-${String(id)}`,
        };
        state.issueComments.push(comment);
        return { status: 201, body: comment };
      }
    }

    // GET /repos/:owner/:repo/pulls/:number
    const prMatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (prMatch !== null && method === "GET") {
      const pr = state.prs.get(Number(prMatch[1]));
      if (pr === undefined) return { status: 404, body: { message: "PR not found" } };
      return { status: 200, body: pr };
    }

    // GET /repos/:owner/:repo/pulls/:number/reviews
    const prReviewsMatch = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (prReviewsMatch !== null && method === "GET") {
      const reviews = state.prReviews.get(Number(prReviewsMatch[1])) ?? [];
      return { status: 200, body: reviews };
    }

    // GET /repos/:owner/:repo/pulls/:number/comments  (inline review comments)
    const prInlineCommentsMatch = /^\/pulls\/(\d+)\/comments$/.exec(rest);
    if (prInlineCommentsMatch !== null && method === "GET") {
      const comments = state.prInlineComments.get(Number(prInlineCommentsMatch[1])) ?? [];
      return { status: 200, body: comments };
    }

    // POST /repos/:owner/:repo/pulls/:number/comments/:id/replies
    const prReplyMatch = /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(rest);
    if (prReplyMatch !== null && method === "POST") {
      const prNumber = Number(prReplyMatch[1]);
      const inReplyTo = Number(prReplyMatch[2]);
      const b = body as { body?: string };
      const id = state.nextCommentId++;
      const now = new Date().toISOString();
      const comment: FakePRReviewComment = {
        id,
        url: `${base}/repos/${owner}/${repo}/pulls/comments/${String(id)}`,
        body: b.body ?? "",
        user: { login: this.#authenticatedUser },
        created_at: now,
        updated_at: now,
        pull_request_url: `${base}/repos/${owner}/${repo}/pulls/${String(prNumber)}`,
        html_url: `${base}/${owner}/${repo}/pull/${String(prNumber)}#pullrequestreviewcomment-${String(id)}`,
        in_reply_to_id: inReplyTo,
      };
      state.prReviewComments.push(comment);
      return { status: 201, body: comment };
    }

    // GET /repos/:owner/:repo/contents/*  (file content)
    if (rest.startsWith("/contents/") && method === "GET") {
      const filePath = rest.slice("/contents/".length);
      const content = state.fileContents.get(filePath);
      if (content === undefined) return { status: 404, body: { message: "File not found" } };
      return { status: 200, body: content };
    }

    return { status: 404, body: { message: `No handler: ${method} /repos/:owner/:repo${rest}` } };
  }
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function emptyRepo(defaultBranch: string): RepoState {
  return {
    defaultBranch,
    issueComments: [],
    prReviewComments: [],
    issues: new Map(),
    prs: new Map(),
    prReviews: new Map(),
    prInlineComments: new Map(),
    fileContents: new Map(),
    nextCommentId: 1000,
  };
}

function filterSince<T extends { created_at: string }>(items: T[], since: string | null): T[] {
  if (since === null) return items;
  const sinceDate = new Date(since);
  return items.filter((item) => new Date(item.created_at) > sinceDate);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        resolve(raw);
      }
    });
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(json)),
  });
  res.end(json);
}
