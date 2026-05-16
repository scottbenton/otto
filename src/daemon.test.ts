import { describe, expect, it } from "vitest";

import { Daemon } from "./daemon.js";

describe("Daemon", () => {
  it("start() resolves after stop()", async () => {
    const daemon = new Daemon();
    const started = daemon.start();
    daemon.stop();
    await expect(started).resolves.toBeUndefined();
  });

  it("stop() is safe to call multiple times", async () => {
    const daemon = new Daemon();
    const started = daemon.start();
    daemon.stop();
    daemon.stop();
    await expect(started).resolves.toBeUndefined();
  });

  it("stop() before start() still resolves", async () => {
    const daemon = new Daemon();
    daemon.stop();
    await expect(daemon.start()).resolves.toBeUndefined();
  });

  it("start() drains active runs before resolving", async () => {
    const daemon = new Daemon();
    let runSettled = false;

    let resolveRun!: () => void;
    const run = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    const started = daemon.start();
    daemon.trackRun(
      run.then(() => {
        runSettled = true;
      }),
    );
    daemon.stop();

    // Yield to let the abort event and allSettled setup run, but run is still pending.
    await Promise.resolve();
    await Promise.resolve();

    expect(runSettled).toBe(false);

    resolveRun();
    await started;

    expect(runSettled).toBe(true);
  });

  it("completed runs are not awaited on stop()", async () => {
    const daemon = new Daemon();
    const started = daemon.start();

    let resolveRun!: () => void;
    const run = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    daemon.trackRun(run);
    resolveRun();
    await run; // run is done before stop

    daemon.stop();
    await expect(started).resolves.toBeUndefined();
  });

  it("signal is aborted after stop()", () => {
    const daemon = new Daemon();
    expect(daemon.signal.aborted).toBe(false);
    daemon.stop();
    expect(daemon.signal.aborted).toBe(true);
  });
});
