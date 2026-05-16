import type { GitHubClient } from "../github/client.js";
import type { IssueComment, RawComment } from "../polling/types.js";
import type {
  HydratedContext,
  IssueDetails,
  PullRequestReview,
  ThreadComment,
} from "./types.js";

const MAX_COMMENTS = 200;

type GitHubIssueResponse = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name?: string }>;
  pull_request?: { url: string };
};

type GitHubPullResponse = {
  base: { ref: string };
  head: { ref: string };
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

function isIssueComment(comment: RawComment): comment is IssueComment {
  return "issue_url" in comment;
}

function parseRepoInfo(url: string): { owner: string; repo: string; number: number } {
  const match = /\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/.exec(url);
  if (match === null) {
    throw new Error(`Cannot parse repo info from URL: ${url}`);
  }
  return { owner: match[1]!, repo: match[2]!, number: parseInt(match[4]!, 10) };
}

function toIssueDetails(raw: GitHubIssueResponse): IssueDetails {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    author: raw.user?.login ?? null,
    labels: raw.labels.flatMap((l) => (l.name !== undefined ? [l.name] : [])),
  };
}

function toThreadComment(raw: GitHubCommentResponse): ThreadComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    body: raw.body,
    createdAt: raw.created_at,
  };
}

function toReview(raw: GitHubReviewResponse): PullRequestReview {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    state: raw.state,
    body: raw.body,
    submittedAt: raw.submitted_at,
  };
}

async function fetchComments(
  client: GitHubClient,
  commentsUrl: string,
): Promise<{ comments: ThreadComment[]; truncated: boolean }> {
  const raw = await client.paginateAll<GitHubCommentResponse>(commentsUrl);
  const truncated = raw.length > MAX_COMMENTS;
  return { comments: raw.slice(0, MAX_COMMENTS).map(toThreadComment), truncated };
}

async function hydrateFromIssueUrl(
  client: GitHubClient,
  issueUrl: string,
): Promise<HydratedContext> {
  const { owner, repo, number } = parseRepoInfo(issueUrl);
  const issueRaw = await client.request<GitHubIssueResponse>(issueUrl);
  const issue = toIssueDetails(issueRaw);

  if (issueRaw.pull_request !== undefined) {
    const pullsUrl = issueUrl.replace(/\/issues\/(\d+)$/, "/pulls/$1");
    const [pullRaw, reviewsRaw] = await Promise.all([
      client.request<GitHubPullResponse>(pullsUrl),
      client.paginateAll<GitHubReviewResponse>(`${pullsUrl}/reviews`),
    ]);
    return {
      kind: "pull_request",
      owner,
      repo,
      number,
      issue,
      pullRequest: { baseBranch: pullRaw.base.ref, headBranch: pullRaw.head.ref },
      reviews: reviewsRaw.map(toReview),
    };
  }

  const { comments, truncated } = await fetchComments(client, `${issueUrl}/comments`);
  return { kind: "issue", owner, repo, number, issue, comments, truncated };
}

async function hydrateFromPrUrl(
  client: GitHubClient,
  pullUrl: string,
): Promise<HydratedContext> {
  const { owner, repo, number } = parseRepoInfo(pullUrl);
  const issueUrl = pullUrl.replace(/\/pulls\/(\d+)$/, "/issues/$1");

  const [issueRaw, pullRaw, reviewsRaw] = await Promise.all([
    client.request<GitHubIssueResponse>(issueUrl),
    client.request<GitHubPullResponse>(pullUrl),
    client.paginateAll<GitHubReviewResponse>(`${pullUrl}/reviews`),
  ]);

  return {
    kind: "pull_request",
    owner,
    repo,
    number,
    issue: toIssueDetails(issueRaw),
    pullRequest: { baseBranch: pullRaw.base.ref, headBranch: pullRaw.head.ref },
    reviews: reviewsRaw.map(toReview),
  };
}

export async function hydrateContext(
  client: GitHubClient,
  comment: RawComment,
): Promise<HydratedContext> {
  if (isIssueComment(comment)) {
    return hydrateFromIssueUrl(client, comment.issue_url);
  }
  return hydrateFromPrUrl(client, comment.pull_request_url);
}
