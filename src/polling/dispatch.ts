import type { StateStore } from "../state/store.js";
import type { TriggerMatch } from "./trigger.js";
import type { RawComment } from "./types.js";

export type DispatchBatch<T> = {
  targetKey: string;
  items: T[];
};

export type DispatchDecision<T> =
  | {
      status: "started";
      batch: DispatchBatch<T>;
    }
  | {
      status: "queued";
      reason: "target-in-flight" | "global-capacity";
      batch: DispatchBatch<T>;
    };

export type RunConcurrencyGateOptions = {
  maxConcurrentRuns: number;
};

export function filterUnseenTriggers(
  matches: TriggerMatch[],
  state: StateStore,
  repo: string,
): TriggerMatch[] {
  const seen = new Set(state.getSeenCommentIds(repo));
  return matches.filter((m) => !seen.has(m.comment.id));
}

export function getTriggerTargetKey(match: TriggerMatch): string {
  return `${match.repo}#${String(getTargetNumber(match.comment))}`;
}

export class RunConcurrencyGate<T> {
  readonly #maxConcurrentRuns: number;
  readonly #inFlightTargets = new Set<string>();
  readonly #queuedBatches: DispatchBatch<T>[] = [];

  #activeRunCount = 0;

  constructor(options: RunConcurrencyGateOptions) {
    const { maxConcurrentRuns } = options;
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new RangeError("maxConcurrentRuns must be an integer greater than 0");
    }
    this.#maxConcurrentRuns = maxConcurrentRuns;
  }

  get activeRunCount(): number {
    return this.#activeRunCount;
  }

  get queuedBatchCount(): number {
    return this.#queuedBatches.length;
  }

  isTargetInFlight(targetKey: string): boolean {
    return this.#inFlightTargets.has(targetKey);
  }

  submit(batch: DispatchBatch<T>): DispatchDecision<T> {
    if (this.#inFlightTargets.has(batch.targetKey)) {
      this.#queuedBatches.push(batch);
      return { status: "queued", reason: "target-in-flight", batch };
    }

    if (this.#activeRunCount >= this.#maxConcurrentRuns) {
      this.#queuedBatches.push(batch);
      return { status: "queued", reason: "global-capacity", batch };
    }

    this.#start(batch.targetKey);
    return { status: "started", batch };
  }

  complete(targetKey: string): DispatchBatch<T>[] {
    if (!this.#inFlightTargets.delete(targetKey)) {
      return [];
    }

    this.#activeRunCount--;
    return this.#drainQueuedBatches();
  }

  #start(targetKey: string): void {
    this.#inFlightTargets.add(targetKey);
    this.#activeRunCount++;
  }

  #drainQueuedBatches(): DispatchBatch<T>[] {
    const started: DispatchBatch<T>[] = [];

    for (let i = 0; i < this.#queuedBatches.length;) {
      const batch = this.#queuedBatches[i];
      if (batch === undefined) {
        i++;
        continue;
      }

      if (this.#activeRunCount >= this.#maxConcurrentRuns) {
        break;
      }

      if (this.#inFlightTargets.has(batch.targetKey)) {
        i++;
        continue;
      }

      this.#queuedBatches.splice(i, 1);
      this.#start(batch.targetKey);
      started.push(batch);
    }

    return started;
  }
}

function getTargetNumber(comment: RawComment): number {
  const targetUrl = "pull_request_url" in comment ? comment.pull_request_url : comment.issue_url;
  const match = /\/(?:issues|pulls)\/(\d+)$/.exec(targetUrl);
  const rawNumber = match?.[1];
  if (rawNumber === undefined) {
    throw new Error(`Unable to derive target key from comment URL: ${targetUrl}`);
  }
  return Number.parseInt(rawNumber, 10);
}
