import type { GitHubClient } from "../github/client.js";
import { noopLogger, type OttoLogger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { RawComment } from "./types.js";

const OVERLAP_SECONDS = 1;

const OTTO_STATUS_MARKER = "<!-- otto:v1";

type FilterStats = {
  ownComment: number;
  statusComment: number;
  createdBeforeLastPoll: number;
};

function subtractOneSecond(isoString: string): string {
  const d = new Date(isoString);
  d.setSeconds(d.getSeconds() - OVERLAP_SECONDS);
  return d.toISOString();
}

function emptyFilterStats(): FilterStats {
  return {
    ownComment: 0,
    statusComment: 0,
    createdBeforeLastPoll: 0,
  };
}

export function filterComments(
  comments: RawComment[],
  authenticatedUser: string,
  lastPolled: string | undefined,
): RawComment[] {
  return filterCommentsWithStats(comments, authenticatedUser, lastPolled, emptyFilterStats());
}

function filterCommentsWithStats(
  comments: RawComment[],
  authenticatedUser: string,
  lastPolled: string | undefined,
  stats: FilterStats,
): RawComment[] {
  const filtered: RawComment[] = [];

  for (const comment of comments) {
    if (comment.user == null || comment.user.login === authenticatedUser) {
      stats.ownComment++;
      continue;
    }
    if (comment.body.includes(OTTO_STATUS_MARKER)) {
      stats.statusComment++;
      continue;
    }
    if (lastPolled !== undefined && new Date(comment.created_at) < new Date(lastPolled)) {
      stats.createdBeforeLastPoll++;
      continue;
    }
    filtered.push(comment);
  }

  return filtered;
}

export async function pollRepo(
  client: GitHubClient,
  state: StateStore,
  repo: string,
  authenticatedUser: string,
  logger: OttoLogger = noopLogger,
): Promise<RawComment[]> {
  const repoLogger = logger.child({ repo });
  const rawSince = state.getLastPolled(repo);
  const params: Record<string, string> = { per_page: "100" };
  if (rawSince !== undefined) {
    params.since = subtractOneSecond(rawSince);
  }

  repoLogger.debug({ since: params.since }, "poll tick started");

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

  const filterStats = emptyFilterStats();
  const filteredComments = filterCommentsWithStats(
    newComments,
    authenticatedUser,
    rawSince,
    filterStats,
  );
  const filteredCount = filterStats.ownComment + filterStats.statusComment + filterStats.createdBeforeLastPoll;
  if (filteredCount > 0) {
    repoLogger.debug(
      {
        filteredCount,
        filteredByOwnComment: filterStats.ownComment,
        filteredByStatusComment: filterStats.statusComment,
        filteredByCreatedBeforeLastPoll: filterStats.createdBeforeLastPoll,
      },
      "comments filtered",
    );
  }
  repoLogger.debug(
    {
      issueCommentCount: issueComments.length,
      prCommentCount: prComments.length,
      newCommentCount: newComments.length,
      filteredCommentCount: filteredComments.length,
    },
    "poll tick completed",
  );
  return filteredComments;
}

export async function runPollingTick(
  client: GitHubClient,
  state: StateStore,
  repos: string[],
  authenticatedUser: string,
  logger: OttoLogger = noopLogger,
): Promise<Map<string, RawComment[]>> {
  const settled = await Promise.allSettled(
    repos.map(async (repo) => ({
      repo,
      comments: await pollRepo(client, state, repo, authenticatedUser, logger),
    })),
  );

  const result = new Map<string, RawComment[]>();
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      result.set(outcome.value.repo, outcome.value.comments);
    } else {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logger.error({ error: msg }, "repo poll failed");
    }
  }
  return result;
}
