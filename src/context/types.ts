export type IssueDetails = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  labels: string[];
};

export type PullRequestDetails = {
  baseBranch: string;
  headBranch: string;
};

export type ThreadComment = {
  id: number;
  author: string | null;
  body: string;
  createdAt: string;
};

export type PullRequestReview = {
  id: number;
  author: string | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
};

export type IssueContext = {
  kind: "issue";
  owner: string;
  repo: string;
  number: number;
  issue: IssueDetails;
  comments: ThreadComment[];
  truncated: boolean;
};

export type PullRequestContext = {
  kind: "pull_request";
  owner: string;
  repo: string;
  number: number;
  issue: IssueDetails;
  pullRequest: PullRequestDetails;
  reviews: PullRequestReview[];
  inlineThread: ThreadComment[];
};

export type HydratedContext = IssueContext | PullRequestContext;
