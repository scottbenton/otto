import { AuthError } from "./errors.js";
import type { GitHubClient } from "./client.js";

type GitHubUser = {
  login: string;
};

export async function resolveAuthenticatedUser(client: GitHubClient): Promise<string> {
  try {
    const user = await client.request<GitHubUser>("/user");
    return user.login;
  } catch (err) {
    if (err instanceof AuthError) {
      throw new Error(
        `GitHub authentication failed (HTTP ${String(err.statusCode)}): ${err.message}. ` +
          `Ensure your token is valid and has the required scopes (repo, read:org).`,
        { cause: err },
      );
    }
    throw err;
  }
}
