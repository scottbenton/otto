import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchBatch } from "./dispatch.js";
import type { DebounceAccumulatorOptions } from "./debounce.js";
import { DebounceAccumulator } from "./debounce.js";
import type { TriggerMatch } from "./trigger.js";
import type { RawComment } from "./types.js";

function makeComment(id: number, issueNumber = 1, repo = "owner/repo"): RawComment {
  return {
    id,
    url: `https://api.github.com/repos/${repo}/issues/comments/${String(id)}`,
    body: "otto fix this",
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: `https://github.com/${repo}/issues/${String(issueNumber)}#issuecomment-${String(id)}`,
    issue_url: `https://api.github.com/repos/${repo}/issues/${String(issueNumber)}`,
  };
}

function makeTrigger(commentId: number, issueNumber = 1, repo = "owner/repo"): TriggerMatch {
  return {
    comment: makeComment(commentId, issueNumber, repo),
    repo,
    taskDescription: "fix this",
  };
}

function makeAccumulator(
  windowMs: number,
  onBatchReady: (batch: DispatchBatch<TriggerMatch>) => void,
  signal?: AbortSignal,
): DebounceAccumulator {
  const opts: DebounceAccumulatorOptions = { windowMs, onBatchReady };
  if (signal !== undefined) opts.signal = signal;
  return new DebounceAccumulator(opts);
}

describe("DebounceAccumulator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts with pendingCount of 0", () => {
    const acc = makeAccumulator(1000, vi.fn());
    expect(acc.pendingCount).toBe(0);
  });

  it("hasPending returns false before any trigger added", () => {
    const acc = makeAccumulator(1000, vi.fn());
    expect(acc.hasPending("owner/repo#1")).toBe(false);
  });

  it("hasPending returns true after a trigger is added", () => {
    const acc = makeAccumulator(1000, vi.fn());
    acc.add(makeTrigger(1));
    expect(acc.hasPending("owner/repo#1")).toBe(true);
  });

  it("pendingCount increments when triggers for different targets are added", () => {
    const acc = makeAccumulator(1000, vi.fn());
    acc.add(makeTrigger(1, 1));
    acc.add(makeTrigger(2, 2));
    expect(acc.pendingCount).toBe(2);
  });

  it("pendingCount does not increment when triggers for the same target are added", () => {
    const acc = makeAccumulator(1000, vi.fn());
    acc.add(makeTrigger(1, 1));
    acc.add(makeTrigger(2, 1));
    expect(acc.pendingCount).toBe(1);
  });

  it("does not fire batch before the window elapses", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    acc.add(makeTrigger(1));
    vi.advanceTimersByTime(999);
    expect(onBatchReady).not.toHaveBeenCalled();
  });

  it("fires batch with a single trigger when window elapses", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    const trigger = makeTrigger(1);
    acc.add(trigger);
    vi.advanceTimersByTime(1000);
    expect(onBatchReady).toHaveBeenCalledOnce();
    const batch = (onBatchReady.mock.calls[0] as [DispatchBatch<TriggerMatch>])[0];
    expect(batch.targetKey).toBe("owner/repo#1");
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toBe(trigger);
  });

  it("accumulates multiple triggers for the same target into one batch", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    const t1 = makeTrigger(1, 1);
    const t2 = makeTrigger(2, 1);
    const t3 = makeTrigger(3, 1);
    acc.add(t1);
    vi.advanceTimersByTime(400);
    acc.add(t2);
    vi.advanceTimersByTime(400);
    acc.add(t3);
    vi.advanceTimersByTime(600);
    expect(onBatchReady).toHaveBeenCalledOnce();
    const batch = (onBatchReady.mock.calls[0] as [DispatchBatch<TriggerMatch>])[0];
    expect(batch.items).toHaveLength(3);
    expect(batch.items).toEqual([t1, t2, t3]);
  });

  it("fires separate batches for different targets", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    acc.add(makeTrigger(1, 1));
    acc.add(makeTrigger(2, 2));
    vi.advanceTimersByTime(1000);
    expect(onBatchReady).toHaveBeenCalledTimes(2);
    const calls = onBatchReady.mock.calls as unknown as [[DispatchBatch<TriggerMatch>], [DispatchBatch<TriggerMatch>]];
    const keys = [calls[0][0].targetKey, calls[1][0].targetKey];
    expect(keys).toContain("owner/repo#1");
    expect(keys).toContain("owner/repo#2");
  });

  it("clears pending state after batch fires", () => {
    const acc = makeAccumulator(1000, vi.fn());
    acc.add(makeTrigger(1));
    vi.advanceTimersByTime(1000);
    expect(acc.pendingCount).toBe(0);
    expect(acc.hasPending("owner/repo#1")).toBe(false);
  });

  it("accepts new triggers for the same target after the previous batch fired", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    acc.add(makeTrigger(1, 1));
    vi.advanceTimersByTime(1000);
    acc.add(makeTrigger(2, 1));
    vi.advanceTimersByTime(1000);
    expect(onBatchReady).toHaveBeenCalledTimes(2);
  });

  it("uses targetKey derived from the comment URL", () => {
    const onBatchReady = vi.fn();
    const acc = makeAccumulator(1000, onBatchReady);
    acc.add(makeTrigger(1, 42, "myorg/myrepo"));
    vi.advanceTimersByTime(1000);
    const batch = (onBatchReady.mock.calls[0] as [DispatchBatch<TriggerMatch>])[0];
    expect(batch.targetKey).toBe("myorg/myrepo#42");
  });

  describe("abort signal", () => {
    it("cancels all pending timers when aborted", () => {
      const onBatchReady = vi.fn();
      const controller = new AbortController();
      const acc = makeAccumulator(1000, onBatchReady, controller.signal);
      acc.add(makeTrigger(1, 1));
      acc.add(makeTrigger(2, 2));
      controller.abort();
      vi.advanceTimersByTime(2000);
      expect(onBatchReady).not.toHaveBeenCalled();
    });

    it("clears pendingCount after abort", () => {
      const controller = new AbortController();
      const acc = makeAccumulator(1000, vi.fn(), controller.signal);
      acc.add(makeTrigger(1));
      controller.abort();
      expect(acc.pendingCount).toBe(0);
    });

    it("ignores new triggers added after abort", () => {
      const onBatchReady = vi.fn();
      const controller = new AbortController();
      const acc = makeAccumulator(1000, onBatchReady, controller.signal);
      controller.abort();
      acc.add(makeTrigger(1));
      vi.advanceTimersByTime(2000);
      expect(onBatchReady).not.toHaveBeenCalled();
    });
  });
});
