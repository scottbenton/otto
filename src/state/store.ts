import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { StateFileSchema, type StateFile } from "./schema.js";

const STATE_FILENAME = "state.json";
const STATE_TMP_FILENAME = "state.json.tmp";

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export class StateStore {
  readonly #stateDir: string;
  #data: StateFile;

  private constructor(stateDir: string, data: StateFile) {
    this.#stateDir = stateDir;
    this.#data = data;
  }

  static async load(stateDir: string): Promise<StateStore> {
    await mkdir(stateDir, { recursive: true });

    const statePath = join(stateDir, STATE_FILENAME);
    let data: StateFile;

    try {
      const raw = await readFile(statePath, "utf8");
      data = StateFileSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      data = StateFileSchema.parse({
        machineId: crypto.randomUUID()
      });
      await atomicWrite(statePath, JSON.stringify(data, null, 2));
    }

    return new StateStore(stateDir, data);
  }

  get machineId(): string {
    return this.#data.machineId;
  }

  getLastPolled(repo: string): string | undefined {
    return this.#data.lastPolled[repo];
  }

  getSeenCommentIds(repo: string): number[] {
    return this.#data.seenCommentIds[repo] ?? [];
  }

  getRepoDefaultBranch(repo: string): string | undefined {
    return this.#data.repoDefaultBranches[repo];
  }

  getWorktree(targetKey: string): StateFile["worktrees"][string] | undefined {
    return this.#data.worktrees[targetKey];
  }

  listWorktrees(): (StateFile["worktrees"][string] & { targetKey: string })[] {
    return Object.entries(this.#data.worktrees).map(([targetKey, worktree]) => ({
      targetKey,
      ...worktree
    }));
  }

  async setLastPolled(repo: string, timestamp: string): Promise<void> {
    this.#data = {
      ...this.#data,
      lastPolled: { ...this.#data.lastPolled, [repo]: timestamp }
    };
    await this.#save();
  }

  async addSeenCommentIds(repo: string, ids: number[]): Promise<void> {
    const existing = new Set(this.getSeenCommentIds(repo));
    for (const id of ids) existing.add(id);
    this.#data = {
      ...this.#data,
      seenCommentIds: {
        ...this.#data.seenCommentIds,
        [repo]: [...existing]
      }
    };
    await this.#save();
  }

  async setRepoDefaultBranch(repo: string, defaultBranch: string): Promise<void> {
    this.#data = {
      ...this.#data,
      repoDefaultBranches: {
        ...this.#data.repoDefaultBranches,
        [repo]: defaultBranch
      }
    };
    await this.#save();
  }

  async setWorktree(
    targetKey: string,
    worktree: StateFile["worktrees"][string],
  ): Promise<void> {
    this.#data = {
      ...this.#data,
      worktrees: {
        ...this.#data.worktrees,
        [targetKey]: worktree
      }
    };
    await this.#save();
  }

  async removeWorktree(targetKey: string): Promise<void> {
    const worktrees = Object.fromEntries(
      Object.entries(this.#data.worktrees).filter(([key]) => key !== targetKey)
    );
    this.#data = {
      ...this.#data,
      worktrees
    };
    await this.#save();
  }

  async #save(): Promise<void> {
    const statePath = join(this.#stateDir, STATE_FILENAME);
    await atomicWrite(statePath, JSON.stringify(this.#data, null, 2));
  }
}

export { STATE_FILENAME, STATE_TMP_FILENAME };
