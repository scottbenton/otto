import type { GitHubClient } from "./client.js";
import { COMMENT_FOOTER } from "../polling/format.js";

type RepoInfo = {
  default_branch: string;
};

type GitHubPullRequest = {
  number: number;
  html_url: string;
};

export type CreatePrInput = {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  agentPrBody?: string;
};

export type PullRequestInfo = {
  number: number;
  htmlUrl: string;
};

function fallbackPrBody(issueNumber: number): string {
  return `Closes #${String(issueNumber)}${COMMENT_FOOTER}`;
}

function normalizeAgentPrBody(body: string | undefined, issueNumber: number): string {
  const closingLine = `Closes #${String(issueNumber)}`;
  const trimmed = body?.trim();
  if (trimmed === undefined || trimmed.length === 0) return fallbackPrBody(issueNumber);

  const lines = trimmed.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }

  const withoutExistingClose = lines.filter(
    (line) => line.trim() !== closingLine && line.trim() !== "---" && !line.includes("[🤖 Otto]")
  );
  while (
    withoutExistingClose.length > 0 &&
    withoutExistingClose[withoutExistingClose.length - 1]?.trim() === ""
  ) {
    withoutExistingClose.pop();
  }
  return [...withoutExistingClose, "", closingLine].join("\n") + COMMENT_FOOTER;
}

export async function createPrForIssueTask(
  client: GitHubClient,
  input: CreatePrInput
): Promise<PullRequestInfo> {
  const { owner, repo, issueNumber, issueTitle, branch, agentPrBody } = input;

  const repoInfo = await client.request<RepoInfo>(`/repos/${owner}/${repo}`);

  const pr = await client.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title: issueTitle,
      body: normalizeAgentPrBody(agentPrBody, issueNumber),
      head: branch,
      base: repoInfo.default_branch
    }
  });

  return { number: pr.number, htmlUrl: pr.html_url };
}
