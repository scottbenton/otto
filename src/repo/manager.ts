import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { StateStore } from "../state/store.js";

const execFileAsync = promisify(execFile);
const repoSlugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export type GitRunnerOptions = {
  cwd?: string;
};

export type GitRunnerResult = {
  stdout: string;
  stderr: string;
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

    if (!(await pathIsDirectory(worktreePath, "Worktree"))) {
      await mkdir(this.#worktreesDir, { recursive: true });
      await this.#gitRunner(["worktree", "add", worktreePath, input.branch], {
        cwd: repo.path
      });
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
    await this.#stateStore.removeWorktree(targetKey);
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
    throw new RepoManagerError(`Git command failed: git ${args.join(" ")}`, {
      cause: err
    });
  }
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
