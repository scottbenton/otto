import type { PullRequestLineContext, SourceType } from "../context/types.js";
import type { AgentRunInput } from "./types.js";

export type RenderAgentPromptOptions = {
  systemPrompt?: string;
};

export function renderAgentPrompt(input: AgentRunInput, options: RenderAgentPromptOptions): string {
  const { context } = input;
  const sections: [string, string][] = [
    ["System instructions", options.systemPrompt ?? ""],
    ["Task framing", renderFraming(context.sourceType)],
    ["Requested task", input.task],
    ["Repository context", renderRepositoryContext(input)],
    ["Issue or PR", renderIssueContext(input)],
    ["Pull request", renderPullRequestContext(input)],
    ["Reviews", renderReviews(input)],
    ["Comment thread", renderComments(input)],
    ["Line contexts", renderLineContexts(context.lineContexts)],
    ["Git instructions", renderGitInstructions()],
    ["Output instructions", renderOutputInstructions(input)]
  ];

  return sections
    .filter(([, body]) => body.trim().length > 0)
    .map(([title, body]) => `## ${title}\n\n${body.trim()}`)
    .join("\n\n");
}

function renderFraming(sourceType: SourceType): string {
  switch (sourceType) {
    case "issue_comment":
      return "Implement the requested change from scratch based on the issue and triggering comment.";
    case "pr_conversation_comment":
      return "Address a review or discussion comment on an existing pull request.";
    case "pr_line_comment":
      return "Fix the specific lines of code that were commented on in the pull request.";
  }
}

function renderRepositoryContext(input: AgentRunInput): string {
  const { context } = input;
  return [
    `Repository: ${context.owner}/${context.repo}`,
    `Number: #${context.number.toString()}`,
    `Source type: ${context.sourceType}`,
    `OTTO_REPO_PATH: ${input.repoPaths[0] ?? ""}`,
    `All repo paths: ${input.repoPaths.join(", ") || "(none)"}`
  ].join("\n");
}

function renderIssueContext(input: AgentRunInput): string {
  const { issue } = input.context;
  return [
    `Title: ${issue.title}`,
    `Number: #${issue.number.toString()}`,
    `State: ${issue.state}`,
    `Author: ${issue.author ?? "(unknown)"}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
    "",
    issue.body ?? "(no body)"
  ].join("\n");
}

function renderPullRequestContext(input: AgentRunInput): string {
  const { pullRequest } = input.context;
  if (pullRequest === null) return "";

  return [
    `Base branch: ${pullRequest.baseBranch}`,
    `Head branch: ${pullRequest.headBranch}`,
    `Head SHA: ${pullRequest.headSha}`
  ].join("\n");
}

function renderReviews(input: AgentRunInput): string {
  const { reviews } = input.context;
  if (reviews.length === 0) return "(none)";

  return reviews
    .map((review) =>
      [
        `Review ${review.id.toString()} by ${review.author ?? "(unknown)"}`,
        `State: ${review.state}`,
        `Submitted: ${review.submittedAt ?? "(unknown)"}`,
        `Body: ${review.body ?? "(no body)"}`
      ].join("\n")
    )
    .join("\n\n");
}

function renderComments(input: AgentRunInput): string {
  const { comments } = input.context;
  if (comments.length === 0) return "(none)";

  return comments
    .map((comment) =>
      [
        `Comment ID ${comment.id.toString()} (${comment.author ?? "(unknown)"}) at ${comment.createdAt}:`,
        indent(comment.body)
      ].join("\n")
    )
    .join("\n\n");
}

function renderLineContexts(lineContexts: PullRequestLineContext[]): string {
  if (lineContexts.length === 0) return "";

  return lineContexts.map(renderLineContext).join("\n\n");
}

function renderLineContext(lineContext: PullRequestLineContext): string {
  if (lineContext.outdated) {
    return [
      `Comment ID: ${lineContext.id.toString()}`,
      `Path: ${lineContext.path}`,
      "Status: outdated",
      "This comment is outdated. Explain the situation instead of guessing at code that may no longer exist.",
      `Clarification: ${lineContext.clarifyMessage}`,
      "",
      "Original diff patch:",
      lineContext.patch ?? "(no patch)"
    ].join("\n");
  }

  return [
    `Comment ID: ${lineContext.id.toString()}`,
    `Path: ${lineContext.path}`,
    `Position: ${lineContext.position.toString()}`,
    `Current file path: ${lineContext.currentFile.path}`,
    `Current file ref: ${lineContext.currentFile.ref}`,
    "",
    "Diff patch:",
    lineContext.patch ?? "(no patch)",
    "",
    "Full current file content:",
    lineContext.currentFile.content
  ].join("\n");
}

function renderGitInstructions(): string {
  return [
    "The repository is already checked out at OTTO_REPO_PATH on the correct branch.",
    "Make changes in that repository.",
    "Commit your changes with a clear message.",
    "Do not push; Otto will push the branch after your run succeeds.",
    "Do not create new branches.",
    "Do not open pull requests or merge requests; Otto will open one when the trigger requires it."
  ].join("\n");
}

function renderOutputInstructions(input: AgentRunInput): string {
  return [
    "Output only a JSON object as your entire response, with no Markdown fence or surrounding prose.",
    'Use this exact shape: { "summary": "...", "commentSummaries": { "<commentId>": "..." } }.',
    "The summary and commentSummaries values must be suitable for posting publicly as GitHub comments.",
    "Do not include secrets, internal file paths, raw logs, or token values.",
    "Use these trigger comment IDs as keys in commentSummaries:",
    ...input.context.comments.map(
      (comment) =>
        `Comment ID ${comment.id.toString()} (${comment.author ?? "(unknown)"}): ${JSON.stringify(comment.body)}`
    )
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
