import type { GitHubClient } from "../github/client.js";
import { buildComment } from "./format.js";
import type { RawComment } from "./types.js";

const MARKER_RE =
  /<!--\s*otto:v1\s+status\s+run=([\w-]+)\s+machine=([\w-]+)\s+source=(\S+)\s*-->/;

type ParsedMarker = { runId: string; machineId: string; sourceKey: string };

function parseMarker(body: string): ParsedMarker | null {
  const match = MARKER_RE.exec(body);
  if (!match) return null;
  return { runId: match[1]!, machineId: match[2]!, sourceKey: match[3]! };
}

function isStaleRunningComment(comment: RawComment, machineId: string): boolean {
  const parsed = parseMarker(comment.body);
  if (!parsed || parsed.machineId !== machineId) return false;
  return /\bStatus:\s*running\b/.test(comment.body);
}

const INTERRUPTED_CONTENT =
  "Status: interrupted — daemon restarted. Remove this comment and re-trigger to retry.";

export async function recoverStaleComments(
  client: GitHubClient,
  repos: string[],
  machineId: string,
  authenticatedUser: string,
): Promise<void> {
  for (const repo of repos) {
    const [owner, repoName] = repo.split("/") as [string, string];

    const [issueComments, prComments] = await Promise.all([
      client.paginateAll<RawComment>(`/repos/${owner}/${repoName}/issues/comments`),
      client.paginateAll<RawComment>(`/repos/${owner}/${repoName}/pulls/comments`),
    ]);

    const stale = [...issueComments, ...prComments].filter(
      (c) => c.user?.login === authenticatedUser && isStaleRunningComment(c, machineId),
    );

    await Promise.all(
      stale.map(async (c) => {
        const parsed = parseMarker(c.body)!;
        await client.request(c.url, {
          method: "PATCH",
          body: {
            body: buildComment(parsed.runId, parsed.machineId, parsed.sourceKey, INTERRUPTED_CONTENT),
          },
        });
      }),
    );
  }
}
