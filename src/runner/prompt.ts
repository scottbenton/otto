import type { PullRequestLineContext } from "../context/types.js";
import type { AgentRunInput } from "./types.js";

export type RenderAgentPromptOptions = {
  systemPrompt: string;
};

export function renderAgentPrompt(input: AgentRunInput, options: RenderAgentPromptOptions): string {
  const { context } = input;
  const repoPath = input.repoPaths[0] ?? "";
  const sections: [string, string][] = [
    ["System instructions", options.systemPrompt],
    ["Task", input.task],
    [
      "Repository",
      [
        `GitHub: ${context.owner}/${context.repo}#${context.number.toString()}`,
        `Source type: ${context.sourceType}`,
        `Repo path: ${repoPath}`,
        `All repo paths: ${input.repoPaths.join(", ") || "(none)"}`
      ].join("\n")
    ],
    [
      "Git instructions",
      [
        "The repository is already checked out at OTTO_REPO_PATH.",
        "Make the requested code changes there.",
        "Commit your changes with a clear message before returning.",
        "Use the current branch only.",
        "Never force-push."
      ].join("\n")
    ],
    ["Issue", renderIssue(input)],
    ["Pull request", renderPullRequest(input)],
    ["Relevant comments", renderComments(input)],
    ["Reviews", renderReviews(input)],
    ["Line context", renderLineContext(context.lineContext)],
    [
      "Output",
      [
        "Return only a short public summary of what changed.",
        "Do not include secrets, private filesystem paths, raw logs, or token values."
      ].join("\n")
    ]
  ];

  return sections
    .filter(([, body]) => body.trim().length > 0)
    .map(([title, body]) => `## ${title}\n\n${body.trim()}`)
    .join("\n\n");
}

function renderIssue(input: AgentRunInput): string {
  const { issue } = input.context;
  return [
    `#${issue.number.toString()}: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.author ?? "(unknown)"}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
    "",
    issue.body ?? "(no issue body)"
  ].join("\n");
}

function renderPullRequest(input: AgentRunInput): string {
  const { pullRequest } = input.context;
  if (pullRequest === null) return "";
  return [
    `Base branch: ${pullRequest.baseBranch}`,
    `Head branch: ${pullRequest.headBranch}`,
    `Head SHA: ${pullRequest.headSha}`
  ].join("\n");
}

function renderComments(input: AgentRunInput): string {
  const { comments } = input.context;
  if (comments.length === 0) return "(none)";
  return comments
    .map((comment) =>
      [
        `- Comment ${comment.id.toString()} by ${comment.author ?? "(unknown)"} at ${comment.createdAt}:`,
        indent(comment.body)
      ].join("\n")
    )
    .join("\n");
}

function renderReviews(input: AgentRunInput): string {
  const { reviews } = input.context;
  if (reviews.length === 0) return "(none)";
  return reviews
    .map((review) =>
      [
        `- Review ${review.id.toString()} by ${review.author ?? "(unknown)"}: ${review.state}`,
        `  Submitted: ${review.submittedAt ?? "(unknown)"}`,
        indent(review.body ?? "(no review body)")
      ].join("\n")
    )
    .join("\n");
}

function renderLineContext(lineContext: PullRequestLineContext | null): string {
  if (lineContext === null) return "";
  if (lineContext.outdated) {
    return [
      `Comment ID: ${lineContext.id.toString()}`,
      `Path: ${lineContext.path}`,
      "Status: outdated",
      `Clarification: ${lineContext.clarifyMessage}`,
      "",
      lineContext.patch ?? "(no patch)"
    ].join("\n");
  }

  return [
    `Comment ID: ${lineContext.id.toString()}`,
    `Path: ${lineContext.path}`,
    `Position: ${lineContext.position.toString()}`,
    `Current file ref: ${lineContext.currentFile.ref}`,
    "",
    "Patch:",
    lineContext.patch ?? "(no patch)",
    "",
    "Current file content:",
    lineContext.currentFile.content
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
