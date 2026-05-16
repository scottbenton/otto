import type { GitHubClient } from "../github/client.js";
import { noopLogger, type OttoLogger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import { runPollingTick } from "./poller.js";
import type { RawComment } from "./types.js";

export type PollingLoopOptions = {
  client: GitHubClient;
  state: StateStore;
  repos: string[];
  intervalMs: number;
  authenticatedUser: string;
  onNewComments: (repo: string, comments: RawComment[]) => void;
  logger?: OttoLogger;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class PollingLoop {
  readonly #client: GitHubClient;
  readonly #state: StateStore;
  readonly #repos: string[];
  readonly #intervalMs: number;
  readonly #authenticatedUser: string;
  readonly #onNewComments: (repo: string, comments: RawComment[]) => void;
  readonly #logger: OttoLogger;

  #abortController: AbortController | null = null;
  #loopDone: Promise<void> | null = null;

  constructor(options: PollingLoopOptions) {
    this.#client = options.client;
    this.#state = options.state;
    this.#repos = options.repos;
    this.#intervalMs = options.intervalMs;
    this.#authenticatedUser = options.authenticatedUser;
    this.#onNewComments = options.onNewComments;
    this.#logger = options.logger ?? noopLogger;
  }

  start(): void {
    this.#abortController = new AbortController();
    this.#logger.info(
      { repoCount: this.#repos.length, intervalMs: this.#intervalMs },
      "polling loop started",
    );
    this.#loopDone = this.#run(this.#abortController.signal);
  }

  beginShutdown(): void {
    this.#logger.info({}, "polling loop shutdown requested");
    this.#abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.#loopDone;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const results = await runPollingTick(
        this.#client,
        this.#state,
        this.#repos,
        this.#authenticatedUser,
        this.#logger,
      );
      for (const [repo, comments] of results) {
        if (comments.length > 0) {
          this.#logger.info(
            { repo, commentIds: comments.map((comment) => comment.id) },
            "new comments detected",
          );
          this.#onNewComments(repo, comments);
        }
      }
      await sleep(this.#intervalMs, signal);
    }
    this.#logger.info({}, "polling loop stopped");
  }
}
