import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubClient } from "../github/client.js";
import { NonFastForwardError, type RepoManager } from "../repo/manager.js";
import { MockRunner } from "../runner/mock.js";
import { StateStore } from "../state/store.js";
import { FakeGitHubServer, type FakeIssue, type FakeIssueComment } from "../testing/fake-github.js";
import type { OttoLogger } from "../logger.js";
import type { DispatchBatch } from "../polling/dispatch.js";
import { runPollingTick } from "../polling/poller.js";
import { recoverStaleComments } from "../polling/recovery.js";
import { buildStatusComment } from "../polling/status.js";
import { detectTrigger, type TriggerMatch } from "../polling/trigger.js";
import { executeRun } from "./execute.js";

const OWNER = "owner";
const REPO = "repo";
const SLUG = `${OWNER}/${REPO}`;
const AUTH_USER = "alice";
const MACHINE_ID = "machine-test-id";

let rootDir: string;
let server: FakeGitHubServer;
let client: GitHubClient;
let state: StateStore;

type RepoManagerCall = "prepareWorktree" | "pushBranch" | "releaseWorktree";

type StubRepoManagerOptions = {
  pushError?: Error;
};

function makeLogger(): OttoLogger {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as OttoLogger;
  vi.mocked(logger.child).mockReturnValue(logger);
  return logger;
}

function makeRepoManager(options: StubRepoManagerOptions = {}): {
  manager: RepoManager;
  calls: RepoManagerCall[];
} {
  const calls: RepoManagerCall[] = [];
  const manager = {
    prepareWorktree: vi.fn().mockImplementation((input: { slug: string; branch: string }) => {
      calls.push("prepareWorktree");
      return Promise.resolve({
        slug: input.slug,
        path: join(rootDir, "worktree"),
        branch: input.branch,
        repoPath: join(rootDir, "repo")
      });
    }),
    pushBranch: vi.fn().mockImplementation((input: { branch: string }) => {
      calls.push("pushBranch");
      if (options.pushError !== undefined) return Promise.reject(options.pushError);
      return Promise.resolve({ branch: input.branch, commits: ["abc123"] });
    }),
    releaseWorktree: vi.fn().mockImplementation(() => {
      calls.push("releaseWorktree");
      return Promise.resolve();
    })
  } as unknown as RepoManager;
  return { manager, calls };
}

function makeIssue(number = 1): FakeIssue {
  return {
    number,
    title: "Fix the bug",
    body: "The widget is broken.",
    state: "open",
    user: { login: "bob" },
    labels: [{ name: "bug" }]
  };
}

function makeIssueComment(id: number, issueNumber = 1, body = "otto fix this"): FakeIssueComment {
  return {
    id,
    url: `${server.baseUrl}/repos/${OWNER}/${REPO}/issues/comments/${String(id)}`,
    body,
    user: { login: AUTH_USER },
    created_at: "2026-05-19T12:00:00.000Z",
    updated_at: "2026-05-19T12:00:00.000Z",
    issue_url: server.issueUrl(OWNER, REPO, issueNumber),
    html_url: `${server.baseUrl}/${OWNER}/${REPO}/issues/${String(issueNumber)}#issuecomment-${String(id)}`
  };
}

async function issueComments(): Promise<FakeIssueComment[]> {
  return client.paginateAll<FakeIssueComment>(`/repos/${OWNER}/${REPO}/issues/1/comments`);
}

function statusBodies(comments: FakeIssueComment[]): string[] {
  return comments.filter((comment) => comment.body.includes("otto:v1 status")).map((c) => c.body);
}

async function pollAndDetect(): Promise<DispatchBatch<TriggerMatch>> {
  const results = await runPollingTick(client, state, [SLUG], AUTH_USER);
  const comments = results.get(SLUG) ?? [];
  const matches = comments
    .map((comment) => detectTrigger(comment, SLUG, "otto"))
    .filter((match): match is TriggerMatch => match !== null);

  expect(matches).toHaveLength(1);
  return {
    targetKey: `${SLUG}#1`,
    items: matches
  };
}

async function executeBatch(
  batch: DispatchBatch<TriggerMatch>,
  runner: MockRunner,
  repoManager: RepoManager,
  onRunComplete = vi.fn()
): Promise<ReturnType<typeof vi.fn>> {
  await executeRun(batch, {
    github: client,
    machineId: MACHINE_ID,
    repoManager,
    agentRunner: runner,
    timeoutMs: 30_000,
    onRunComplete,
    logger: makeLogger()
  });
  return onRunComplete;
}

beforeEach(async () => {
  rootDir = join(tmpdir(), `otto-task-flow-${crypto.randomUUID()}`);
  await mkdir(rootDir, { recursive: true });
  server = new FakeGitHubServer({ authenticatedUser: AUTH_USER });
  await server.start();
  server.seedRepo(OWNER, REPO);
  server.addIssue(OWNER, REPO, makeIssue());
  client = new GitHubClient("ghp_test", server.baseUrl);
  state = await StateStore.load(join(rootDir, "state"));
});

afterEach(async () => {
  await server.stop();
  await rm(rootDir, { recursive: true, force: true });
});

describe("task flow e2e", () => {
  it("polls, claims, hydrates, runs, creates a PR, and reports completion", async () => {
    server.addIssueComment(OWNER, REPO, makeIssueComment(101));
    const batch = await pollAndDetect();
    const runner = new MockRunner({
      result: {
        success: true,
        summary: "Implemented the requested fix.",
        prBody: "## What was done\n\nFixed the widget.\n\nCloses #1"
      }
    });
    const { manager, calls } = makeRepoManager();

    const onRunComplete = await executeBatch(batch, runner, manager);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.task).toBe("otto fix this");
    expect(runner.calls[0]?.context.issue.title).toBe("Fix the bug");
    expect(calls).toEqual(["prepareWorktree", "pushBranch", "releaseWorktree"]);
    expect(onRunComplete).toHaveBeenCalledWith(`${SLUG}#1`);

    const comments = await issueComments();
    const bodies = statusBodies(comments);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Status: completed");
    expect(bodies[0]).toContain(`Branch: https://github.com/${SLUG}/tree/`);
    expect(bodies[0]).toContain(`Pull request: ${server.baseUrl}/${OWNER}/${REPO}/pull/1`);
    expect(bodies[0]).toContain("Implemented the requested fix.");

    const prCreate = server.requests.find(
      (request) => request.method === "POST" && request.path === `/repos/${OWNER}/${REPO}/pulls`
    );
    expect(prCreate?.body).toMatchObject({
      title: "Fix the bug",
      base: "main"
    });
    expect((prCreate?.body as { body?: string }).body).toContain("## What was done");
  });

  it("does not return the same trigger on a second poll", async () => {
    server.addIssueComment(OWNER, REPO, makeIssueComment(101));

    const first = await runPollingTick(client, state, [SLUG], AUTH_USER);
    const second = await runPollingTick(client, state, [SLUG], AUTH_USER);

    expect(first.get(SLUG)?.map((comment) => comment.id)).toEqual([101]);
    expect(second.get(SLUG)).toEqual([]);
  });

  it("skips a trigger that was already claimed before execution starts", async () => {
    server.addIssueComment(OWNER, REPO, makeIssueComment(101));
    server.addIssueComment(
      OWNER,
      REPO,
      makeIssueComment(
        900,
        1,
        buildStatusComment(
          { runId: "existing-run", machineId: "other-machine", sourceKey: "issue_comment:101" },
          { status: "running" }
        )
      )
    );
    const batch = await pollAndDetect();
    const runner = new MockRunner();
    const { manager, calls } = makeRepoManager();

    const onRunComplete = await executeBatch(batch, runner, manager);

    expect(runner.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(onRunComplete).toHaveBeenCalledWith(`${SLUG}#1`);
  });

  it("marks stale running comments from this machine as interrupted on recovery", async () => {
    server.addIssueComment(
      OWNER,
      REPO,
      makeIssueComment(
        900,
        1,
        buildStatusComment(
          { runId: "stale-run", machineId: MACHINE_ID, sourceKey: "issue_comment:101" },
          { status: "running" }
        )
      )
    );

    await recoverStaleComments(client, [SLUG], MACHINE_ID, AUTH_USER);

    const bodies = statusBodies(await issueComments());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("run=stale-run");
    expect(bodies[0]).toContain("Status: interrupted");
  });

  it("reports a failed status when push is rejected as non-fast-forward", async () => {
    server.addIssueComment(OWNER, REPO, makeIssueComment(101));
    const batch = await pollAndDetect();
    const runner = new MockRunner({ result: { success: true, summary: "Implemented fix." } });
    const { manager, calls } = makeRepoManager({
      pushError: new NonFastForwardError("rejected non-fast-forward")
    });

    await executeBatch(batch, runner, manager);

    expect(runner.calls).toHaveLength(1);
    expect(calls).toEqual(["prepareWorktree", "pushBranch", "releaseWorktree"]);

    const bodies = statusBodies(await issueComments());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Status: failed");
    expect(bodies[0]).toContain("Otto never force-pushes");
    expect(bodies[0]).toContain("To retry, post a new comment: otto retry");
  });
});
