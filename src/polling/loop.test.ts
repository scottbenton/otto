import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollingLoop } from "./loop.js";
import type { RawComment } from "./types.js";

// Stub runPollingTick so loop tests don't need real client/state
vi.mock("./poller.js", () => ({
  runPollingTick: vi.fn().mockResolvedValue(new Map()),
}));

import { runPollingTick } from "./poller.js";

describe("PollingLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeLoop(intervalMs = 60_000, onNewComments?: (repo: string, comments: RawComment[]) => void) {
    return new PollingLoop({
      client: {} as never,
      state: {} as never,
      repos: ["owner/repo"],
      intervalMs,
      authenticatedUser: "alice",
      onNewComments: onNewComments ?? (() => undefined),
    });
  }

  it("runs a tick immediately on start", async () => {
    const loop = makeLoop();
    loop.start();
    await Promise.resolve(); // drain microtask queue so first tick completes
    expect(runPollingTick).toHaveBeenCalledTimes(1);
    loop.beginShutdown();
    await loop.waitForIdle();
  });

  it("runs subsequent ticks after each interval", async () => {
    const loop = makeLoop(1_000);
    loop.start();

    await vi.advanceTimersByTimeAsync(3_100);

    expect(runPollingTick).toHaveBeenCalledTimes(4); // immediate + 3 intervals
    loop.beginShutdown();
    await loop.waitForIdle();
  });

  it("stops ticking after beginShutdown()", async () => {
    const loop = makeLoop(1_000);
    loop.start();

    await vi.advanceTimersByTimeAsync(500);
    loop.beginShutdown();
    await loop.waitForIdle();

    const callsAfterStop = (runPollingTick as ReturnType<typeof vi.fn>).mock.calls.length;

    await vi.advanceTimersByTimeAsync(5_000);

    expect((runPollingTick as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterStop);
  });

  it("calls onNewComments when a tick returns results", async () => {
    const comment: RawComment = {
      id: 1,
      body: "hello",
      user: { login: "alice" },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com",
      issue_url: "https://api.github.com/repos/owner/repo/issues/1",
    };
    vi.mocked(runPollingTick).mockResolvedValueOnce(
      new Map([["owner/repo", [comment]]]),
    );

    const onNewComments = vi.fn();
    const loop = makeLoop(60_000, onNewComments);
    loop.start();
    await Promise.resolve(); // drain microtask queue so first tick completes
    loop.beginShutdown();
    await loop.waitForIdle();

    expect(onNewComments).toHaveBeenCalledWith("owner/repo", [comment]);
  });

  it("waitForIdle resolves after the loop exits", async () => {
    const loop = makeLoop(1_000);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    loop.beginShutdown();

    await expect(loop.waitForIdle()).resolves.toBeUndefined();
  });
});
