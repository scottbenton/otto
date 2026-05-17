import type { GitHubClient } from "./client.js";

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
};

export type PullRequestInfo = {
  number: number;
  htmlUrl: string;
};

export async function createPrForIssueTask(
  client: GitHubClient,
  input: CreatePrInput,
): Promise<PullRequestInfo> {
  const { owner, repo, issueNumber, issueTitle, branch } = input;

  const repoInfo = await client.request<RepoInfo>(`/repos/${owner}/${repo}`);

  const pr = await client.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: {
      title: issueTitle,
      body: `Closes #${String(issueNumber)}`,
      head: branch,
      base: repoInfo.default_branch,
    },
  });

  return { number: pr.number, htmlUrl: pr.html_url };
}
