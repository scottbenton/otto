import type { DispatchBatch } from "./dispatch.js";
import { getTriggerTargetKey } from "./dispatch.js";
import type { TriggerMatch } from "./trigger.js";

export type DebounceAccumulatorOptions = {
  windowMs: number;
  onBatchReady: (batch: DispatchBatch<TriggerMatch>) => void;
  signal?: AbortSignal;
};

type PendingEntry = {
  triggers: TriggerMatch[];
  timer: ReturnType<typeof setTimeout>;
};

export class DebounceAccumulator {
  readonly #windowMs: number;
  readonly #onBatchReady: (batch: DispatchBatch<TriggerMatch>) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #pending = new Map<string, PendingEntry>();

  constructor(opts: DebounceAccumulatorOptions) {
    this.#windowMs = opts.windowMs;
    this.#onBatchReady = opts.onBatchReady;
    this.#signal = opts.signal;
    opts.signal?.addEventListener("abort", () => { this.#cancelAll(); });
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  hasPending(targetKey: string): boolean {
    return this.#pending.has(targetKey);
  }

  cancelForTarget(targetKey: string): void {
    const entry = this.#pending.get(targetKey);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#pending.delete(targetKey);
  }

  add(match: TriggerMatch): void {
    if (this.#signal?.aborted === true) return;
    const targetKey = getTriggerTargetKey(match);
    const existing = this.#pending.get(targetKey);

    if (existing !== undefined) {
      existing.triggers.push(match);
      return;
    }

    const timer = setTimeout(() => { this.#fire(targetKey); }, this.#windowMs);
    this.#pending.set(targetKey, { triggers: [match], timer });
  }

  #fire(targetKey: string): void {
    const entry = this.#pending.get(targetKey);
    if (entry === undefined) return;
    this.#pending.delete(targetKey);
    this.#onBatchReady({ targetKey, items: entry.triggers });
  }

  #cancelAll(): void {
    for (const { timer } of this.#pending.values()) {
      clearTimeout(timer);
    }
    this.#pending.clear();
  }
}
