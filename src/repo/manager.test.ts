import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateStore } from "../state/store.js";
import {
  NonFastForwardError,
  RepoManager,
  RepoManagerError,
  type GitRunner,
  type GitRunnerOptions,
  type GitRunnerResult,
} from "./manager.js";

type GitCall = {
  args: string[];
  options: GitRunnerOptions;
};

type RunnerOutput = string | Partial<GitRunnerResult>;

let rootDir: string;
let reposDir: string;
let worktreesDir: string;
let stateDir: string;
let store: StateStore;
let calls: GitCall[];

function createRunner(outputs: string[] = []): GitRunner {
  return (args, options = {}) => {
    calls.push({ args, options });
    const stdout = outputs.shift() ?? "";
    return Promise.resolve({ stdout, stderr: "" });
  };
}

function createAdvancedRunner(outputs: RunnerOutput[] = []): GitRunner {
  return (args, options = {}) => {
    calls.push({ args, options });
    const output = outputs.shift() ?? "";
    if (typeof output === "string") {
      return Promise.resolve({ stdout: output, stderr: "" });
    }
    return Promise.resolve({ stdout: output.stdout ?? "", stderr: output.stderr ?? "", exitCode: output.exitCode });
  };
}

beforeEach(async () => {
  rootDir = join(tmpdir(), `otto-repo-manager-${String(Date.now())}`);
  reposDir = join(rootDir, "repos");
  worktreesDir = join(rootDir, "worktrees");
  stateDir = join(rootDir, "state");
  calls = [];
  await mkdir(reposDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
  store = await StateStore.load(stateDir);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("RepoManager.prepareWorktree()", () => {
  it("creates a deterministic git worktree for a target and records it in state", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    const worktree = await manager.prepareWorktree({
      slug: "owner/repo",
      targetKey: "owner/repo#123",
      branch: "otto/owner-repo-123"
    });

    const worktreePath = join(worktreesDir, "owner-repo-123");
    expect(worktree).toEqual({
      slug: "owner/repo",
      path: worktreePath,
      branch: "otto/owner-repo-123",
      repoPath: checkoutPath
    });
    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["branch", "--list", "--format=%(refname:short)", "otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["worktree", "add", "-b", "otto/owner-repo-123", worktreePath, "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["status", "--porcelain"],
        options: { cwd: worktreePath }
      }
    ]);
    expect(store.getWorktree("owner/repo#123")).toEqual({
      repo: "owner/repo",
      path: worktreePath,
      branch: "otto/owner-repo-123"
    });
  });

  it("reuses an existing worktree directory without running git worktree add", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    const worktreePath = join(worktreesDir, "owner-repo-123");
    await mkdir(checkoutPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await manager.prepareWorktree({
      slug: "owner/repo",
      targetKey: "owner/repo#123",
      branch: "otto/owner-repo-123"
    });

    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["status", "--porcelain"],
        options: { cwd: worktreePath }
      }
    ]);
    expect(store.getWorktree("owner/repo#123")?.path).toBe(worktreePath);
  });

  it("rejects an existing worktree with uncommitted changes", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    const worktreePath = join(worktreesDir, "owner-repo-123");
    await mkdir(checkoutPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner(["", "", " M src/index.ts\n"])
    });

    await expect(
      manager.prepareWorktree({
        slug: "owner/repo",
        targetKey: "owner/repo#123",
        branch: "otto/owner-repo-123"
      })
    ).rejects.toThrow(/uncommitted changes/);

    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["status", "--porcelain"],
        options: { cwd: worktreePath }
      }
    ]);
    expect(store.getWorktree("owner/repo#123")).toBeUndefined();
  });

  it("resets and reuses an existing branch when it has no unmerged commits", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner(["", "", "otto/owner-repo-123\n", "0\n", "", "", ""])
    });

    await manager.prepareWorktree({
      slug: "owner/repo",
      targetKey: "owner/repo#123",
      branch: "otto/owner-repo-123"
    });

    const worktreePath = join(worktreesDir, "owner-repo-123");
    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["branch", "--list", "--format=%(refname:short)", "otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["rev-list", "--count", "origin/main..otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["branch", "--force", "otto/owner-repo-123", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["worktree", "add", worktreePath, "otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["status", "--porcelain"],
        options: { cwd: worktreePath }
      }
    ]);
  });

  it("rejects an existing branch with unmerged commits", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner(["", "", "otto/owner-repo-123\n", "2\n"])
    });

    await expect(
      manager.prepareWorktree({
        slug: "owner/repo",
        targetKey: "owner/repo#123",
        branch: "otto/owner-repo-123"
      })
    ).rejects.toThrow(/unmerged commits/);

    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["branch", "--list", "--format=%(refname:short)", "otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      },
      {
        args: ["rev-list", "--count", "origin/main..otto/owner-repo-123"],
        options: { cwd: checkoutPath }
      }
    ]);
    expect(store.getWorktree("owner/repo#123")).toBeUndefined();
  });

  it("removes worktree directory and state on release", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    const worktreePath = join(worktreesDir, "owner-repo-123");
    await mkdir(worktreePath, { recursive: true });
    await store.setWorktree("owner/repo#123", {
      repo: "owner/repo",
      path: worktreePath,
      branch: "otto/owner-repo-123"
    });
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await manager.releaseWorktree("owner/repo#123");

    expect(store.getWorktree("owner/repo#123")).toBeUndefined();
    expect(calls).toContainEqual({
      args: ["worktree", "remove", "--force", worktreePath],
      options: { cwd: checkoutPath, allowNonZeroExit: true },
    });
  });

  it("clears worktree state on release even when no state entry exists", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await manager.releaseWorktree("owner/repo#999");

    expect(store.getWorktree("owner/repo#999")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-directory at the computed worktree path", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    await writeFile(join(worktreesDir, "owner-repo-123"), "not a worktree", "utf8");
    await store.setRepoDefaultBranch("owner/repo", "main");
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await expect(
      manager.prepareWorktree({
        slug: "owner/repo",
        targetKey: "owner/repo#123",
        branch: "otto/owner-repo-123"
      })
    ).rejects.toThrow(RepoManagerError);
  });
});

describe("RepoManager.prepareRepository()", () => {
  it("clones a missing repo under reposDir and stores the resolved default branch", async () => {
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner(["", "origin/main\n"])
    });

    const checkout = await manager.prepareRepository({
      slug: "owner/repo",
      cloneUrl: "https://github.com/owner/repo.git"
    });

    expect(checkout).toEqual({
      path: join(reposDir, "owner-repo"),
      slug: "owner/repo",
      defaultBranch: "main"
    });
    expect(calls).toEqual([
      {
        args: ["clone", "https://github.com/owner/repo.git", join(reposDir, "owner-repo")],
        options: {}
      },
      {
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        options: { cwd: join(reposDir, "owner-repo") }
      }
    ]);
    expect(store.getRepoDefaultBranch("owner/repo")).toBe("main");
  });

  it("updates an existing checkout with fetch and fast-forward merge", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    await store.setRepoDefaultBranch("owner/repo", "trunk");
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    const checkout = await manager.prepareRepository({ slug: "owner/repo" });

    expect(checkout.defaultBranch).toBe("trunk");
    expect(calls).toEqual([
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/trunk"],
        options: { cwd: checkoutPath }
      }
    ]);
  });

  it("resolves and stores the default branch for existing checkouts without state", async () => {
    const checkoutPath = join(reposDir, "owner-repo");
    await mkdir(checkoutPath, { recursive: true });
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner(["origin/main\n", "", ""])
    });

    await manager.prepareRepository({ slug: "owner/repo" });

    expect(calls).toEqual([
      {
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        options: { cwd: checkoutPath }
      },
      { args: ["fetch", "origin"], options: { cwd: checkoutPath } },
      {
        args: ["merge", "--ff-only", "origin/main"],
        options: { cwd: checkoutPath }
      }
    ]);
    expect(store.getRepoDefaultBranch("owner/repo")).toBe("main");
  });

  it("derives the GitHub clone URL from the repo slug when cloneUrl is omitted", async () => {
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner(["", "origin/main\n"])
    });

    await manager.prepareRepository({ slug: "owner/repo" });

    expect(calls[0]?.args).toEqual([
      "clone",
      "https://github.com/owner/repo.git",
      join(reposDir, "owner-repo")
    ]);
  });

  it("rejects malformed repo slugs before running git", async () => {
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await expect(manager.prepareRepository({ slug: "../owner/repo" })).rejects.toThrow(
      RepoManagerError
    );
    expect(calls).toEqual([]);
  });

  it("rejects a non-directory at the computed checkout path", async () => {
    await writeFile(join(reposDir, "owner-repo"), "not a checkout", "utf8");
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await expect(manager.prepareRepository({ slug: "owner/repo" })).rejects.toThrow(
      RepoManagerError
    );
    expect(calls).toEqual([]);
  });

  it("rejects a symlink at the computed checkout path", async () => {
    const externalDir = join(rootDir, "external");
    await mkdir(externalDir, { recursive: true });
    await symlink(externalDir, join(reposDir, "owner-repo"));
    const manager = new RepoManager({
      reposDir,
      stateStore: store,
      gitRunner: createRunner()
    });

    await expect(manager.prepareRepository({ slug: "owner/repo" })).rejects.toThrow(
      RepoManagerError
    );
    expect(calls).toEqual([]);
  });
});

describe("RepoManager.pushBranch()", () => {
  const repoPath = "/fake/repo";
  const worktreePath = "/fake/worktree";
  const branch = "otto/owner-repo-123";

  it("returns branch and commits when push succeeds and remote tracking exists", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createAdvancedRunner([
        // git log origin/branch..HEAD
        "abc123\ndef456\n",
        // git push --porcelain origin branch
        { stdout: " \trefs/heads/otto/owner-repo-123:refs/heads/otto/owner-repo-123\tabc..def\n", stderr: "" },
      ]),
    });

    const result = await manager.pushBranch({ repoPath, worktreePath, branch });

    expect(result).toEqual({ branch, commits: ["abc123", "def456"] });
  });

  it("falls back to HEAD commit when remote tracking branch does not exist", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createAdvancedRunner([
        // git log origin/branch..HEAD — remote branch missing (exit 128)
        { stdout: "", stderr: "fatal: ambiguous argument 'origin/otto/owner-repo-123..HEAD'", exitCode: 128 },
        // git rev-parse HEAD
        "abc123\n",
        // git push --porcelain origin branch
        { stdout: "*\trefs/heads/otto/owner-repo-123:refs/heads/otto/owner-repo-123\t[new branch]\n", stderr: "" },
      ]),
    });

    const result = await manager.pushBranch({ repoPath, worktreePath, branch });

    expect(result).toEqual({ branch, commits: ["abc123"] });
  });

  it("throws NonFastForwardError when push is rejected with non-fast-forward", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createAdvancedRunner([
        // git log origin/branch..HEAD
        "abc123\n",
        // git push — rejected
        {
          stdout: "!\trefs/heads/otto/owner-repo-123:refs/heads/otto/owner-repo-123\t[rejected] (non-fast-forward)\n",
          stderr: "",
          exitCode: 1,
        },
      ]),
    });

    await expect(manager.pushBranch({ repoPath, worktreePath, branch })).rejects.toThrow(
      NonFastForwardError
    );
  });

  it("throws RepoManagerError (not NonFastForwardError) on other push failures", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createAdvancedRunner([
        // git log origin/branch..HEAD
        "abc123\n",
        // git push — generic failure (no [rejected] text)
        { stdout: "", stderr: "fatal: unable to connect to remote", exitCode: 128 },
      ]),
    });

    let caughtError: unknown;
    try {
      await manager.pushBranch({ repoPath, worktreePath, branch });
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(RepoManagerError);
    expect(caughtError).not.toBeInstanceOf(NonFastForwardError);
  });

  it("runs git push with repoPath as cwd, not worktreePath", async () => {
    const manager = new RepoManager({
      reposDir,
      worktreesDir,
      stateStore: store,
      gitRunner: createAdvancedRunner([
        "abc123\n",
        { stdout: " \trefs/heads/otto/owner-repo-123:refs/heads/otto/owner-repo-123\tabc..def\n", stderr: "" },
      ]),
    });

    await manager.pushBranch({ repoPath, worktreePath, branch });

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.options.cwd).toBe(repoPath);
  });
});
