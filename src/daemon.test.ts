import { describe, expect, it, vi } from "vitest";

import { createDaemon, type LifecycleRuntime } from "./daemon.js";

function makeRuntime(overrides?: Partial<LifecycleRuntime>): LifecycleRuntime {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createDaemon state transitions", () => {
  it("starts in created state", () => {
    const daemon = createDaemon(makeRuntime());
    expect(daemon.getState()).toBe("created");
  });

  it("transitions created -> running after start()", async () => {
    const daemon = createDaemon(makeRuntime());
    await daemon.start();
    expect(daemon.getState()).toBe("running");
  });

  it("transitions running -> stopped after stop()", async () => {
    const daemon = createDaemon(makeRuntime());
    await daemon.start();
    await daemon.stop();
    expect(daemon.getState()).toBe("stopped");
  });
});

describe("createDaemon start() idempotency", () => {
  it("concurrent start() calls return the same promise", () => {
    const daemon = createDaemon(makeRuntime());
    const p1 = daemon.start();
    const p2 = daemon.start();
    expect(p1).toBe(p2);
  });

  it("start() after running is a no-op", async () => {
    const runtime = makeRuntime();
    const daemon = createDaemon(runtime);
    await daemon.start();
    await daemon.start();
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it("start() after stopped is a no-op", async () => {
    const runtime = makeRuntime();
    const daemon = createDaemon(runtime);
    await daemon.start();
    await daemon.stop();
    await daemon.start();
    expect(runtime.start).toHaveBeenCalledOnce();
  });
});

describe("createDaemon stop() idempotency", () => {
  it("concurrent stop() calls return the same promise", async () => {
    const daemon = createDaemon(makeRuntime());
    await daemon.start();
    const p1 = daemon.stop();
    const p2 = daemon.stop();
    expect(p1).toBe(p2);
    await p1;
  });

  it("stop() from created state is a no-op", async () => {
    const runtime = makeRuntime();
    const daemon = createDaemon(runtime);
    await daemon.stop();
    expect(daemon.getState()).toBe("stopped");
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("stop() from stopped state is a no-op", async () => {
    const runtime = makeRuntime();
    const daemon = createDaemon(runtime);
    await daemon.start();
    await daemon.stop();
    await daemon.stop();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});

describe("createDaemon stop() during start()", () => {
  it("stop() while starting waits for start before stopping", async () => {
    let resolveStart!: () => void;
    const runtime = makeRuntime({
      start: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveStart = resolve; }),
      ),
    });

    const daemon = createDaemon(runtime);
    const startP = daemon.start();
    const stopP = daemon.stop();

    resolveStart();
    await startP;
    await stopP;

    expect(daemon.getState()).toBe("stopped");
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});

describe("createDaemon runtime hooks", () => {
  it("calls beginShutdown before waitForIdle before stop", async () => {
    const order: string[] = [];
    const runtime = makeRuntime({
      beginShutdown: vi.fn().mockImplementation(() => { order.push("beginShutdown"); return Promise.resolve(); }),
      waitForIdle: vi.fn().mockImplementation(() => { order.push("waitForIdle"); return Promise.resolve(); }),
      stop: vi.fn().mockImplementation(() => { order.push("stop"); return Promise.resolve(); }),
    });

    const daemon = createDaemon(runtime);
    await daemon.start();
    await daemon.stop();

    expect(order).toEqual(["beginShutdown", "waitForIdle", "stop"]);
  });

  it("works without optional beginShutdown and waitForIdle", async () => {
    const daemon = createDaemon(makeRuntime());
    await daemon.start();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});

describe("createDaemon failed start", () => {
  it("cleans up and sets stopped state if start throws", async () => {
    const runtime = makeRuntime({
      start: vi.fn().mockRejectedValue(new Error("startup failed")),
    });

    const daemon = createDaemon(runtime);
    await expect(daemon.start()).rejects.toThrow("startup failed");
    expect(daemon.getState()).toBe("stopped");
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});
