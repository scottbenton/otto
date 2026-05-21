import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { StateStore } from "../state/store.js";

const execFileAsync = promisify(execFile);
const repoSlugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export type GitRunnerOptions = {
  cwd?: string;
  /** When true, return stdout/stderr/exitCode instead of throwing on non-zero exit. */
  allowNonZeroExit?: boolean;
};

export type GitRunnerResult = {
  stdout: string;
  stderr: string;
  /** Set only when allowNonZeroExit:true and the process exited non-zero. */
  exitCode?: number;
};

export type GitRunner = (args: string[], options?: GitRunnerOptions) => Promise<GitRunnerResult>;

export type PrepareRepositoryInput = {
  slug: string;
  cloneUrl?: string;
};

export type PreparedRepository = {
  slug: string;
  path: string;
  defaultBranch: string;
};

export type PrepareWorktreeInput = PrepareRepositoryInput & {
  targetKey: string;
  branch: string;
  mode: "new" | "existing";
  /** Branch to base the new worktree on. Defaults to the repo's default branch. */
  baseBranch?: string;
};

export type PreparedWorktree = {
  slug: string;
  path: string;
  branch: string;
  repoPath: string;
};

export class RepoManagerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepoManagerError";
  }
}

export class NonFastForwardError extends RepoManagerError {
  constructor(message: string) {
    super(message);
    this.name = "NonFastForwardError";
  }
}

export class NoChangesError extends RepoManagerError {
  constructor(message: string) {
    super(message);
    this.name = "NoChangesError";
  }
}

export type PushBranchInput = {
  /** Path to the bare/primary repo clone (where git push runs). */
  repoPath: string;
  /** Path to the git worktree checked out on `branch` (where git log runs). */
  worktreePath: string;
  branch: string;
};

export type PushBranchResult = {
  branch: string;
  commits: string[];
};

export type CleanupOptions = {
  dryRun?: boolean;
};

export type CleanupWorktreeReason = "remote-deleted" | "merged";

export type CleanupWorktreeItem = {
  targetKey: string;
  repo: string;
  path: string;
  branch: string;
  reason: CleanupWorktreeReason;
  deleted: boolean;
};

export type CleanupBranchItem = {
  repo: string;
  branch: string;
  deleted: boolean;
};

export type CleanupWorktreesResult = {
  stale: CleanupWorktreeItem[];
};

export type CleanupBranchesInput = CleanupOptions & {
  repos: string[];
};

export type CleanupBranchesResult = {
  branches: CleanupBranchItem[];
};

type RepoManagerOptions = {
  reposDir: string;
  worktreesDir?: string;
  stateStore: StateStore;
  gitRunner?: GitRunner;
};

export class RepoManager {
  readonly #reposDir: string;
  readonly #worktreesDir: string;
  readonly #stateStore: StateStore;
  readonly #gitRunner: GitRunner;

  constructor(options: RepoManagerOptions) {
    this.#reposDir = resolve(options.reposDir);
    this.#worktreesDir = resolve(options.worktreesDir ?? options.reposDir);
    this.#stateStore = options.stateStore;
    this.#gitRunner = options.gitRunner ?? runGit;
  }

  async prepareRepository(input: PrepareRepositoryInput): Promise<PreparedRepository> {
    const checkoutPath = this.#checkoutPath(input.slug);

    if (await pathIsDirectory(checkoutPath, "Repository checkout")) {
      const defaultBranch = await this.#getOrResolveDefaultBranch(input.slug, checkoutPath);
      await this.#gitRunner(["fetch", "origin"], { cwd: checkoutPath });
      await this.#gitRunner(["checkout", defaultBranch], { cwd: checkoutPath });
      await this.#gitRunner(["merge", "--ff-only", `origin/${defaultBranch}`], {
        cwd: checkoutPath
      });
      return { slug: input.slug, path: checkoutPath, defaultBranch };
    }

    await mkdir(this.#reposDir, { recursive: true });
    await this.#gitRunner(["clone", input.cloneUrl ?? defaultCloneUrl(input.slug), checkoutPath]);
    const defaultBranch = await this.#resolveDefaultBranch(checkoutPath);
    await this.#stateStore.setRepoDefaultBranch(input.slug, defaultBranch);
    return { slug: input.slug, path: checkoutPath, defaultBranch };
  }

  async prepareWorktree(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    const repo = await this.prepareRepository(input);
    const worktreePath = this.#worktreePath(input.targetKey);
    const baseBranch = input.baseBranch ?? repo.defaultBranch;
    const worktreeExists = await pathIsDirectory(worktreePath, "Worktree");

    if (!worktreeExists) {
      await mkdir(this.#worktreesDir, { recursive: true });
      if (input.mode === "existing") {
        await this.#addExistingBranchWorktree(repo.path, worktreePath, input.branch);
      } else {
        await this.#addNewBranchWorktree(repo.path, worktreePath, input.branch, baseBranch);
      }
    }

    if (worktreeExists || input.mode === "existing") {
      await this.#prepareExistingWorktree(repo.path, worktreePath, input.branch, input.mode, baseBranch);
    } else {
      await this.#assertCleanWorktree(worktreePath);
    }

    await this.#stateStore.setWorktree(input.targetKey, {
      repo: input.slug,
      path: worktreePath,
      branch: input.branch
    });

    return {
      slug: input.slug,
      path: worktreePath,
      branch: input.branch,
      repoPath: repo.path
    };
  }

  async releaseWorktree(targetKey: string): Promise<void> {
    const entry = this.#stateStore.getWorktree(targetKey);
    if (entry !== undefined) {
      const repoCheckoutPath = this.#checkoutPath(entry.repo);
      await this.#gitRunner(
        ["worktree", "remove", "--force", entry.path],
        { cwd: repoCheckoutPath, allowNonZeroExit: true },
      );
    }
    await this.#stateStore.removeWorktree(targetKey);
  }

  async pushBranch(input: PushBranchInput): Promise<PushBranchResult> {
    const commits = await this.#getPushableCommits(input.worktreePath, input.branch);
    if (commits.length === 0) {
      throw new NoChangesError(
        `No commits to push for branch ${input.branch}; refusing to report completion`
      );
    }

    const pushResult = await this.#gitRunner(
      ["push", "--porcelain", "origin", input.branch],
      { cwd: input.repoPath, allowNonZeroExit: true }
    );

    // Porcelain rejection lines: start with '!' and contain '[rejected]' + 'non-fast-forward'.
    // Check stdout only to avoid false positives from hook messages in stderr.
    const isRejected = pushResult.stdout
      .split("\n")
      .some(
        (line) =>
          line.startsWith("!") &&
          line.includes("[rejected]") &&
          line.includes("non-fast-forward")
      );

    if (isRejected) {
      throw new NonFastForwardError(
        `Push rejected (non-fast-forward) for branch ${input.branch}; refusing to force-push`
      );
    }

    if ((pushResult.exitCode ?? 0) !== 0) {
      const errorDetail = [pushResult.stdout, pushResult.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      throw new RepoManagerError(
        `git push failed for branch ${input.branch}: ${errorDetail}`
      );
    }

    return { branch: input.branch, commits };
  }

  async cleanupWorktrees(options: CleanupOptions = {}): Promise<CleanupWorktreesResult> {
    const stale: CleanupWorktreeItem[] = [];
    const worktrees = this.#stateStore.listWorktrees();
    const repos = new Map<string, typeof worktrees>();

    for (const worktree of worktrees) {
      const repoWorktrees = repos.get(worktree.repo) ?? [];
      repoWorktrees.push(worktree);
      repos.set(worktree.repo, repoWorktrees);
    }

    for (const [repo, repoWorktrees] of repos) {
      const repoPath = this.#checkoutPath(repo);
      if (!(await pathIsDirectory(repoPath, "Repository checkout"))) continue;

      const defaultBranch = await this.#getOrResolveDefaultBranch(repo, repoPath);
      await this.#gitRunner(["fetch", "--prune", "origin"], { cwd: repoPath });
      const mergedRemoteBranches = await this.#listMergedRemoteBranches(
        repoPath,
        defaultBranch,
      );

      for (const worktree of repoWorktrees) {
        const remoteBranch = `origin/${worktree.branch}`;
        const remoteBranchExists = await this.#remoteBranchExists(repoPath, worktree.branch);
        let reason: CleanupWorktreeReason | undefined;
        if (!remoteBranchExists) {
          reason = "remote-deleted";
        } else if (mergedRemoteBranches.includes(remoteBranch)) {
          reason = "merged";
        }

        if (reason === undefined) continue;

        if (options.dryRun !== true) {
          await this.#gitRunner(["worktree", "remove", "--force", worktree.path], {
            cwd: repoPath,
            allowNonZeroExit: true,
          });
          await this.#stateStore.removeWorktree(worktree.targetKey);
        }

        stale.push({
          targetKey: worktree.targetKey,
          repo,
          path: worktree.path,
          branch: worktree.branch,
          reason,
          deleted: options.dryRun !== true,
        });
      }
    }

    return { stale };
  }

  async cleanupBranches(input: CleanupBranchesInput): Promise<CleanupBranchesResult> {
    const branches: CleanupBranchItem[] = [];

    for (const repo of input.repos) {
      const repoPath = this.#checkoutPath(repo);
      if (!(await pathIsDirectory(repoPath, "Repository checkout"))) continue;

      const defaultBranch = await this.#getOrResolveDefaultBranch(repo, repoPath);
      await this.#gitRunner(["fetch", "--prune", "origin"], { cwd: repoPath });

      const mergedBranches = (await this.#listMergedRemoteBranches(repoPath, defaultBranch))
        .map((branch) => branch.trim())
        .filter((branch) => branch.startsWith("origin/otto/"))
        .map((branch) => branch.slice("origin/".length));

      for (const branch of mergedBranches) {
        if (input.dryRun !== true) {
          await this.#gitRunner(["push", "origin", "--delete", branch], { cwd: repoPath });
        }
        branches.push({ repo, branch, deleted: input.dryRun !== true });
      }
    }

    return { branches };
  }

  async #getPushableCommits(worktreePath: string, branch: string): Promise<string[]> {
    // Use allowNonZeroExit so a missing remote-tracking branch (exit 128) is handled
    // without swallowing unrelated errors via a catch-all.
    const logResult = await this.#gitRunner(
      ["log", "--format=%H", `origin/${branch}..HEAD`],
      { cwd: worktreePath, allowNonZeroExit: true }
    );

    if ((logResult.exitCode ?? 0) === 0) {
      return logResult.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Remote tracking branch doesn't exist yet (new branch push) — return HEAD commit.
    const headResult = await this.#gitRunner(["rev-parse", "HEAD"], { cwd: worktreePath });
    return [headResult.stdout.trim()].filter(Boolean);
  }

  async #addExistingBranchWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string
  ): Promise<void> {
    if (!(await this.#remoteBranchExists(repoPath, branch))) {
      throw new RepoManagerError(`Remote branch ${branch} does not exist; unable to modify it`);
    }

    await this.#gitRunner(["worktree", "add", "-B", branch, worktreePath, `origin/${branch}`], {
      cwd: repoPath
    });
  }

  async #addNewBranchWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    defaultBranch: string
  ): Promise<void> {
    const baseRef = `origin/${defaultBranch}`;

    if (await this.#branchExists(repoPath, branch)) {
      const unmergedCommits = await this.#countUnmergedCommits(repoPath, baseRef, branch);
      if (unmergedCommits > 0) {
        throw new RepoManagerError(
          `Branch ${branch} already has unmerged commits; refusing to reset it`
        );
      }

      await this.#gitRunner(["branch", "--force", branch, baseRef], { cwd: repoPath });
      await this.#gitRunner(["worktree", "add", worktreePath, branch], { cwd: repoPath });
      return;
    }

    if (await this.#remoteBranchExists(repoPath, branch)) {
      throw new RepoManagerError(`Remote branch ${branch} already exists; refusing to recreate it`);
    }

    await this.#gitRunner(["worktree", "add", "-b", branch, worktreePath, baseRef], {
      cwd: repoPath
    });
  }

  async #prepareExistingWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    mode: "new" | "existing",
    baseBranch: string
  ): Promise<void> {
    const currentBranch = await this.#currentBranch(worktreePath);
    if (currentBranch !== branch) {
      throw new RepoManagerError(
        `Worktree ${worktreePath} is on branch ${currentBranch}, expected ${branch}`
      );
    }

    await this.#assertCleanWorktree(worktreePath);

    if (mode === "existing") {
      await this.#gitRunner(["reset", "--hard", `origin/${branch}`], { cwd: worktreePath });
      return;
    }

    const unmergedCommits = await this.#countUnmergedCommits(repoPath, `origin/${baseBranch}`, branch);
    if (unmergedCommits > 0) {
      throw new RepoManagerError(
        `Branch ${branch} already has unmerged commits; refusing to reset it`
      );
    }

    await this.#gitRunner(["merge", "--ff-only", `origin/${baseBranch}`], {
      cwd: worktreePath
    });
  }

  async #currentBranch(worktreePath: string): Promise<string> {
    const result = await this.#gitRunner(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath
    });
    return result.stdout.trim();
  }

  async #branchExists(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.#gitRunner(
      ["branch", "--list", "--format=%(refname:short)", branch],
      {
        cwd: repoPath
      }
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes(branch);
  }

  async #remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.#gitRunner(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: repoPath, allowNonZeroExit: true }
    );
    return (result.exitCode ?? 0) === 0;
  }

  async #listMergedRemoteBranches(repoPath: string, defaultBranch: string): Promise<string[]> {
    const result = await this.#gitRunner(
      ["branch", "-r", "--merged", `origin/${defaultBranch}`, "--format=%(refname:short)"],
      { cwd: repoPath }
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async #countUnmergedCommits(repoPath: string, baseRef: string, branch: string): Promise<number> {
    const result = await this.#gitRunner(["rev-list", "--count", `${baseRef}..${branch}`], {
      cwd: repoPath
    });
    const count = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(count)) {
      throw new RepoManagerError(`Unable to count unmerged commits on branch ${branch}`);
    }
    return count;
  }

  async #assertCleanWorktree(worktreePath: string): Promise<void> {
    const result = await this.#gitRunner(["status", "--porcelain"], { cwd: worktreePath });
    if (result.stdout.trim().length > 0) {
      throw new RepoManagerError(
        `Worktree has uncommitted changes from a previous run: ${worktreePath}`
      );
    }
  }

  async #getOrResolveDefaultBranch(slug: string, checkoutPath: string): Promise<string> {
    const stored = this.#stateStore.getRepoDefaultBranch(slug);
    if (stored !== undefined) return stored;

    const resolvedBranch = await this.#resolveDefaultBranch(checkoutPath);
    await this.#stateStore.setRepoDefaultBranch(slug, resolvedBranch);
    return resolvedBranch;
  }

  async #resolveDefaultBranch(checkoutPath: string): Promise<string> {
    const result = await this.#gitRunner(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: checkoutPath
    });
    const ref = result.stdout.trim();
    const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (branch.length === 0) {
      throw new RepoManagerError("Unable to resolve repository default branch");
    }
    return branch;
  }

  #checkoutPath(slug: string): string {
    if (!repoSlugPattern.test(slug)) {
      throw new RepoManagerError(`Invalid repository slug: ${slug}`);
    }
    const checkoutName = slug.replace("/", "-");
    const checkoutPath = resolve(this.#reposDir, checkoutName);
    const relativeCheckoutPath = relative(this.#reposDir, checkoutPath);
    if (relativeCheckoutPath.startsWith("..") || isAbsolute(relativeCheckoutPath)) {
      throw new RepoManagerError(`Repository path escaped reposDir: ${slug}`);
    }
    return checkoutPath;
  }

  #worktreePath(targetKey: string): string {
    const worktreeName = targetKeyToPathSegment(targetKey);
    const worktreePath = resolve(this.#worktreesDir, worktreeName);
    const relativeWorktreePath = relative(this.#worktreesDir, worktreePath);
    if (relativeWorktreePath.startsWith("..") || isAbsolute(relativeWorktreePath)) {
      throw new RepoManagerError(`Worktree path escaped worktreesDir: ${targetKey}`);
    }
    return worktreePath;
  }
}

async function pathIsDirectory(path: string, label: string): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return false;
    throw new RepoManagerError(`Unable to inspect ${label.toLowerCase()} path: ${path}`, {
      cause: err
    });
  }
  if (entry.isDirectory()) return true;
  throw new RepoManagerError(`${label} path is not a directory: ${path}`);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

async function runGit(args: string[], options: GitRunnerOptions = {}): Promise<GitRunnerResult> {
  try {
    return await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8"
    });
  } catch (err) {
    if (options.allowNonZeroExit && isExecError(err)) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
    throw new RepoManagerError(`Git command failed: git ${args.join(" ")}`, {
      cause: err
    });
  }
}

type ExecError = { stdout?: string; stderr?: string; code?: number | string };

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && ("stdout" in err || "stderr" in err);
}

function defaultCloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

function targetKeyToPathSegment(targetKey: string): string {
  const normalized = targetKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new RepoManagerError(`Invalid worktree target key: ${targetKey}`);
  }
  return normalized;
}
