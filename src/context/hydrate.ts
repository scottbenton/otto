import { Buffer } from "node:buffer";

import type { GitHubClient } from "../github/client.js";
import type { IssueComment, PullRequestReviewComment, RawComment } from "../polling/types.js";
import type {
  HydratedContext,
  IssueDetails,
  PullRequestLineContext,
  PullRequestReview,
  ThreadComment
} from "./types.js";

const MAX_COMMENTS = 200;

type GitHubIssueResponse = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: { name?: string }[];
  pull_request?: { url: string };
};

type GitHubPullResponse = {
  html_url: string;
  base: { ref: string };
  head: { ref: string; sha: string };
};

type GitHubReviewResponse = {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
};

type GitHubCommentResponse = {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
};

type GitHubReviewCommentResponse = GitHubCommentResponse & {
  in_reply_to_id?: number;
  path: string;
  patch: string | null;
  position: number | null;
};

type GitHubContentResponse = {
  type: string;
  encoding: string;
  content: string;
};

function isIssueComment(comment: RawComment): comment is IssueComment {
  return "issue_url" in comment;
}

function parseRepoInfo(url: string): { owner: string; repo: string; number: number } {
  const match = /\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  const numberStr = match?.[4];
  if (owner === undefined || repo === undefined || numberStr === undefined) {
    throw new Error(`Cannot parse repo info from URL: ${url}`);
  }
  return { owner, repo, number: parseInt(numberStr, 10) };
}

function toIssueDetails(raw: GitHubIssueResponse): IssueDetails {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    author: raw.user?.login ?? null,
    labels: raw.labels.flatMap((l) => (l.name !== undefined ? [l.name] : []))
  };
}

function toThreadComment(raw: GitHubCommentResponse): ThreadComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    body: raw.body,
    createdAt: raw.created_at
  };
}

function toReview(raw: GitHubReviewResponse): PullRequestReview {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    state: raw.state,
    body: raw.body,
    submittedAt: raw.submitted_at
  };
}

function toPullRequestDetails(raw: GitHubPullResponse) {
  return {
    htmlUrl: raw.html_url,
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
    headSha: raw.head.sha
  };
}

async function fetchComments(
  client: GitHubClient,
  commentsUrl: string
): Promise<{ comments: ThreadComment[]; truncated: boolean }> {
  const raw = await client.paginateAll<GitHubCommentResponse>(commentsUrl);
  const truncated = raw.length > MAX_COMMENTS;
  return { comments: raw.slice(0, MAX_COMMENTS).map(toThreadComment), truncated };
}

function extractInlineThread(
  allComments: GitHubReviewCommentResponse[],
  trigger: PullRequestReviewComment
): ThreadComment[] {
  // All replies in a GitHub thread point to the root comment via in_reply_to_id.
  const rootId = trigger.in_reply_to_id ?? trigger.id;
  return allComments
    .filter((c) => c.id === rootId || c.in_reply_to_id === rootId)
    .map(toThreadComment);
}

function contentsUrl(owner: string, repo: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `/repos/${owner}/${repo}/contents/${encodedPath}`;
}

function decodeContent(raw: GitHubContentResponse): string {
  if (raw.type !== "file" || raw.encoding !== "base64") {
    throw new Error("GitHub contents response is not a base64 file");
  }
  return Buffer.from(raw.content.replace(/\s/g, ""), "base64").toString("utf8");
}

async function buildLineContext(
  client: GitHubClient,
  owner: string,
  repo: string,
  headSha: string,
  raw: GitHubReviewCommentResponse
): Promise<PullRequestLineContext> {
  if (raw.position === null) {
    return {
      outdated: true,
      id: raw.id,
      path: raw.path,
      patch: raw.patch,
      position: null,
      clarifyMessage:
        "This PR line comment is outdated because the code it was attached to has changed. Please ask Otto again on a current line or include the current context."
    };
  }

  const file = await client.request<GitHubContentResponse>(contentsUrl(owner, repo, raw.path), {
    params: { ref: headSha }
  });

  return {
    outdated: false,
    id: raw.id,
    path: raw.path,
    patch: raw.patch,
    position: raw.position,
    currentFile: {
      path: raw.path,
      ref: headSha,
      content: decodeContent(file)
    }
  };
}

async function hydrateFromIssueUrl(
  client: GitHubClient,
  issueUrl: string
): Promise<HydratedContext> {
  const { owner, repo, number } = parseRepoInfo(issueUrl);
  const issueRaw = await client.request<GitHubIssueResponse>(issueUrl);
  const issue = toIssueDetails(issueRaw);

  if (issueRaw.pull_request !== undefined) {
    const pullsUrl = issueUrl.replace(/\/issues\/(\d+)$/, "/pulls/$1");
    const [pullRaw, reviewsRaw, { comments: conversationComments }] = await Promise.all([
      client.request<GitHubPullResponse>(pullsUrl),
      client.paginateAll<GitHubReviewResponse>(`${pullsUrl}/reviews`),
      fetchComments(client, `${issueUrl}/comments`)
    ]);
    return {
      kind: "pull_request",
      owner,
      repo,
      number,
      issue,
      pullRequest: toPullRequestDetails(pullRaw),
      reviews: reviewsRaw.map(toReview),
      inlineThread: conversationComments,
      lineComments: []
    };
  }

  const { comments, truncated } = await fetchComments(client, `${issueUrl}/comments`);
  return { kind: "issue", owner, repo, number, issue, comments, truncated };
}

async function hydrateFromPrUrl(
  client: GitHubClient,
  triggers: PullRequestReviewComment[]
): Promise<HydratedContext> {
  const anchor = triggers.at(-1);
  if (anchor === undefined) throw new Error("hydrateFromPrUrl requires at least one trigger");

  const pullUrl = anchor.pull_request_url;
  const { owner, repo, number } = parseRepoInfo(pullUrl);
  const issueUrl = pullUrl.replace(/\/pulls\/(\d+)$/, "/issues/$1");

  const [issueRaw, pullRaw, reviewsRaw, allReviewComments] = await Promise.all([
    client.request<GitHubIssueResponse>(issueUrl),
    client.request<GitHubPullResponse>(pullUrl),
    client.paginateAll<GitHubReviewResponse>(`${pullUrl}/reviews`),
    client.paginateAll<GitHubReviewCommentResponse>(`${pullUrl}/comments`)
  ]);

  const lineComments = await Promise.all(
    triggers.map(async (trigger) => {
      const reviewCommentRaw = await client.request<GitHubReviewCommentResponse>(trigger.url);
      return buildLineContext(client, owner, repo, pullRaw.head.sha, reviewCommentRaw);
    })
  );

  // Merge inline threads for all triggers, deduplicating by comment ID.
  const seenIds = new Set<number>();
  const inlineThread = triggers
    .flatMap((trigger) => extractInlineThread(allReviewComments, trigger))
    .filter((c) => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    });

  return {
    kind: "pull_request",
    owner,
    repo,
    number,
    issue: toIssueDetails(issueRaw),
    pullRequest: toPullRequestDetails(pullRaw),
    reviews: reviewsRaw.map(toReview),
    inlineThread,
    lineComments
  };
}

export async function hydrateContext(
  client: GitHubClient,
  comments: RawComment[]
): Promise<HydratedContext> {
  const last = comments.at(-1);
  if (last === undefined) throw new Error("hydrateContext requires at least one comment");

  if (isIssueComment(last)) {
    return hydrateFromIssueUrl(client, last.issue_url);
  }

  const prComments = comments.filter((c): c is PullRequestReviewComment => !isIssueComment(c));
  return hydrateFromPrUrl(client, prComments);
}
