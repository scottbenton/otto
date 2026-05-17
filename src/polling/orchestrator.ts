import { DebounceAccumulator } from "./debounce.js";
import { RunConcurrencyGate } from "./dispatch.js";
import type { DispatchBatch } from "./dispatch.js";
import type { TriggerMatch } from "./trigger.js";

export type DispatchOrchestratorOptions = {
  windowMs: number;
  maxConcurrentRuns: number;
  onRunReady: (batch: DispatchBatch<TriggerMatch>) => void;
  signal?: AbortSignal;
};

export class DispatchOrchestrator {
  readonly #debounce: DebounceAccumulator;
  readonly #gate: RunConcurrencyGate<TriggerMatch>;
  readonly #onRunReady: (batch: DispatchBatch<TriggerMatch>) => void;

  constructor(opts: DispatchOrchestratorOptions) {
    this.#onRunReady = opts.onRunReady;
    this.#gate = new RunConcurrencyGate({ maxConcurrentRuns: opts.maxConcurrentRuns });
    this.#debounce = new DebounceAccumulator({
      windowMs: opts.windowMs,
      onBatchReady: (batch) => { this.#onBatchReady(batch); },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  get pendingDebounceCount(): number {
    return this.#debounce.pendingCount;
  }

  get activeRunCount(): number {
    return this.#gate.activeRunCount;
  }

  get queuedBatchCount(): number {
    return this.#gate.queuedBatchCount;
  }

  addTrigger(match: TriggerMatch): void {
    this.#debounce.add(match);
  }

  // Call when a run starts for a target. Cancels any lingering debounce timer to
  // prevent a phantom batch from firing mid-run (edge case during daemon restart recovery).
  onRunStart(targetKey: string): void {
    this.#debounce.cancelForTarget(targetKey);
  }

  // Call when a run completes for a target. Drains the gate's queue and re-feeds
  // any queued batches through debounce so they collect a fresh accumulation window.
  onRunComplete(targetKey: string): void {
    const drained = this.#gate.complete(targetKey);
    for (const batch of drained) {
      for (const trigger of batch.items) {
        this.#debounce.add(trigger);
      }
    }
  }

  #onBatchReady(batch: DispatchBatch<TriggerMatch>): void {
    const decision = this.#gate.submit(batch);
    if (decision.status === "started") {
      // Cancel any lingering timer for this target before the run begins (edge case).
      this.#debounce.cancelForTarget(batch.targetKey);
      this.#onRunReady(batch);
    }
    // If "queued", the gate holds the batch until capacity or target-in-flight clears.
  }
}
