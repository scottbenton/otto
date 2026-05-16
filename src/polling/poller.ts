import type { GitHubClient } from "../github/client.js";
import type { StateStore } from "../state/store.js";
import type { RawComment } from "./types.js";

const OVERLAP_SECONDS = 1;

function subtractOneSecond(isoString: string): string {
  const d = new Date(isoString);
  d.setSeconds(d.getSeconds() - OVERLAP_SECONDS);
  return d.toISOString();
}

export async function pollRepo(
  client: GitHubClient,
  state: StateStore,
  repo: string,
): Promise<RawComment[]> {
  const rawSince = state.getLastPolled(repo);
  const params: Record<string, string> = { per_page: "100" };
  if (rawSince !== undefined) {
    params.since = subtractOneSecond(rawSince);
  }

  const pollStarted = new Date().toISOString();
  const [owner, repoName] = repo.split("/") as [string, string];

  const [issueComments, prComments] = await Promise.all([
    client.paginateAll<RawComment>(`/repos/${owner}/${repoName}/issues/comments`, params),
    client.paginateAll<RawComment>(`/repos/${owner}/${repoName}/pulls/comments`, params),
  ]);

  const seenIds = new Set(state.getSeenCommentIds(repo));
  const newComments: RawComment[] = [];
  const newIds: number[] = [];

  for (const comment of [...issueComments, ...prComments]) {
    if (!seenIds.has(comment.id)) {
      newComments.push(comment);
      newIds.push(comment.id);
    }
  }

  await state.setLastPolled(repo, pollStarted);
  if (newIds.length > 0) {
    await state.addSeenCommentIds(repo, newIds);
  }

  return newComments;
}

export async function runPollingTick(
  client: GitHubClient,
  state: StateStore,
  repos: string[],
): Promise<Map<string, RawComment[]>> {
  const settled = await Promise.allSettled(
    repos.map(async (repo) => ({ repo, comments: await pollRepo(client, state, repo) })),
  );

  const result = new Map<string, RawComment[]>();
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      result.set(outcome.value.repo, outcome.value.comments);
    }
  }
  return result;
}
