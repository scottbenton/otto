import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchBatch } from "./dispatch.js";
import { DispatchOrchestrator } from "./orchestrator.js";
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

function makeOrchestrator(
  onRunReady: (batch: DispatchBatch<TriggerMatch>) => void,
  opts: { windowMs?: number; maxConcurrentRuns?: number; signal?: AbortSignal } = {},
): DispatchOrchestrator {
  return new DispatchOrchestrator({
    windowMs: opts.windowMs ?? 1000,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 2,
    onRunReady,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

describe("DispatchOrchestrator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires onRunReady after the debounce window elapses", () => {
    const onRunReady = vi.fn();
    const orc = makeOrchestrator(onRunReady);
    orc.addTrigger(makeTrigger(1));
    vi.advanceTimersByTime(999);
    expect(onRunReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRunReady).toHaveBeenCalledOnce();
    const batch = (onRunReady.mock.calls[0] as [DispatchBatch<TriggerMatch>])[0];
    expect(batch.targetKey).toBe("owner/repo#1");
    expect(batch.items).toHaveLength(1);
  });

  it("accumulates multiple triggers for the same target into one batch", () => {
    const onRunReady = vi.fn();
    const orc = makeOrchestrator(onRunReady);
    orc.addTrigger(makeTrigger(1));
    orc.addTrigger(makeTrigger(2));
    vi.advanceTimersByTime(1000);
    expect(onRunReady).toHaveBeenCalledOnce();
    const batch = (onRunReady.mock.calls[0] as [DispatchBatch<TriggerMatch>])[0];
    expect(batch.items).toHaveLength(2);
  });

  it("tracks activeRunCount after a run starts", () => {
    const orc = makeOrchestrator(vi.fn());
    orc.addTrigger(makeTrigger(1));
    vi.advanceTimersByTime(1000);
    expect(orc.activeRunCount).toBe(1);
  });

  it("queues second batch for same target while first run is in flight", () => {
    const onRunReady = vi.fn();
    const orc = makeOrchestrator(onRunReady);

    orc.addTrigger(makeTrigger(1));
    vi.advanceTimersByTime(1000);
    expect(onRunReady).toHaveBeenCalledOnce();

    orc.addTrigger(makeTrigger(2));
    vi.advanceTimersByTime(1000);
    expect(onRunReady).toHaveBeenCalledOnce();
    expect(orc.queuedBatchCount).toBe(1);
  });

  describe("onRunComplete — queued batch re-queuing", () => {
    it("re-feeds queued batch through debounce after run completes", () => {
      const onRunReady = vi.fn();
      const orc = makeOrchestrator(onRunReady);

      orc.addTrigger(makeTrigger(1));
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledOnce();

      // Second trigger arrives while first run is in flight
      orc.addTrigger(makeTrigger(2));
      vi.advanceTimersByTime(1000);
      expect(orc.queuedBatchCount).toBe(1);

      // Run completes — queued batch should be re-fed through debounce
      orc.onRunComplete("owner/repo#1");
      expect(orc.queuedBatchCount).toBe(0);
      expect(orc.pendingDebounceCount).toBe(1);

      // Fresh debounce window elapses → second run fires
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledTimes(2);
      const batch = (onRunReady.mock.calls[1] as [DispatchBatch<TriggerMatch>])[0];
      expect(batch.targetKey).toBe("owner/repo#1");
      expect(batch.items[0]).toEqual(makeTrigger(2));
    });

    it("merges new triggers arriving in fresh window with re-queued batch", () => {
      const onRunReady = vi.fn();
      const orc = makeOrchestrator(onRunReady);

      orc.addTrigger(makeTrigger(1));
      vi.advanceTimersByTime(1000);

      orc.addTrigger(makeTrigger(2));
      vi.advanceTimersByTime(1000);

      orc.onRunComplete("owner/repo#1");

      // New trigger arrives before the fresh debounce window closes
      orc.addTrigger(makeTrigger(3));
      vi.advanceTimersByTime(1000);

      expect(onRunReady).toHaveBeenCalledTimes(2);
      const batch = (onRunReady.mock.calls[1] as [DispatchBatch<TriggerMatch>])[0];
      expect(batch.items).toHaveLength(2);
      expect(batch.items.map((t) => t.comment.id)).toEqual([2, 3]);
    });

    it("is a no-op for a target with no queued batches", () => {
      const onRunReady = vi.fn();
      const orc = makeOrchestrator(onRunReady);

      orc.addTrigger(makeTrigger(1));
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledOnce();

      orc.onRunComplete("owner/repo#1");
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledOnce();
    });

    it("drains batches for other targets when global capacity frees up", () => {
      const onRunReady = vi.fn();
      const orc = makeOrchestrator(onRunReady, { maxConcurrentRuns: 1 });

      orc.addTrigger(makeTrigger(1, 1));
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledOnce();

      orc.addTrigger(makeTrigger(2, 2));
      vi.advanceTimersByTime(1000);
      expect(orc.queuedBatchCount).toBe(1);

      orc.onRunComplete("owner/repo#1");
      vi.advanceTimersByTime(1000);
      expect(onRunReady).toHaveBeenCalledTimes(2);
    });
  });

  describe("onRunStart — phantom timer cancellation", () => {
    it("cancels a lingering debounce timer for the target when run starts", () => {
      const onRunReady = vi.fn();
      const orc = makeOrchestrator(onRunReady);

      // Simulate lingering timer (e.g. from restart recovery)
      orc.addTrigger(makeTrigger(1));
      expect(orc.pendingDebounceCount).toBe(1);

      orc.onRunStart("owner/repo#1");
      expect(orc.pendingDebounceCount).toBe(0);

      vi.advanceTimersByTime(2000);
      expect(onRunReady).not.toHaveBeenCalled();
    });

    it("is a no-op when no timer is pending for the target", () => {
      const orc = makeOrchestrator(vi.fn());
      expect(() => { orc.onRunStart("owner/repo#99"); }).not.toThrow();
    });
  });
});
