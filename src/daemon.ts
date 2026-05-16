export class Daemon {
  readonly #ac = new AbortController();
  readonly #activeRuns = new Set<Promise<void>>();

  get signal(): AbortSignal {
    return this.#ac.signal;
  }

  async start(): Promise<void> {
    if (!this.#ac.signal.aborted) {
      await new Promise<void>((resolve) => {
        this.#ac.signal.addEventListener("abort", () => { resolve(); }, {
          once: true,
        });
      });
    }
    if (this.#activeRuns.size > 0) {
      await Promise.allSettled([...this.#activeRuns]);
    }
  }

  stop(): void {
    this.#ac.abort();
  }

  trackRun(run: Promise<void>): void {
    this.#activeRuns.add(run);
    void run.finally(() => {
      this.#activeRuns.delete(run);
    });
  }
}
