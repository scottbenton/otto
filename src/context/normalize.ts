import type { HydratedContext, HydratedGitHubContext } from "./types.js";

export function normalizeContext(ctx: HydratedContext): HydratedGitHubContext {
  if (ctx.kind === "issue") {
    return {
      sourceType: "issue_comment",
      owner: ctx.owner,
      repo: ctx.repo,
      number: ctx.number,
      issue: ctx.issue,
      pullRequest: null,
      reviews: [],
      comments: ctx.comments,
      truncated: ctx.truncated,
      lineContexts: [],
    };
  }

  const sourceType = ctx.lineComments.length > 0 ? "pr_line_comment" : "pr_conversation_comment";
  return {
    sourceType,
    owner: ctx.owner,
    repo: ctx.repo,
    number: ctx.number,
    issue: ctx.issue,
    pullRequest: ctx.pullRequest,
    reviews: ctx.reviews,
    comments: ctx.inlineThread,
    truncated: false,
    lineContexts: ctx.lineComments,
  };
}
