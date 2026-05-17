export { GitHubClient } from "./client.js";
export { resolveAuthenticatedUser } from "./auth.js";
export { createPrForIssueTask } from "./pulls.js";
export type { CreatePrInput, PullRequestInfo } from "./pulls.js";
export {
  GitHubError,
  AuthError,
  NotFoundError,
  RateLimitError,
  SecondaryRateLimitError,
  NetworkError,
} from "./errors.js";
