export type IssueComment = {
  id: number;
  url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  issue_url: string;
  html_url: string;
};

export type PullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  pull_request_url: string;
  html_url: string;
};

export type RawComment = IssueComment | PullRequestReviewComment;
