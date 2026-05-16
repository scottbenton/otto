import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerShutdown } from "./shutdown.js";

function makeProcess() {
  return new EventEmitter();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerShutdown", () => {
  it("signal resolves on first SIGINT", async () => {
    const proc = makeProcess();
    const { signal, dispose } = registerShutdown({ process: proc });
    proc.emit("SIGINT");
    await expect(signal).resolves.toBeUndefined();
    dispose();
  });

  it("signal resolves on first SIGTERM", async () => {
    const proc = makeProcess();
    const { signal, dispose } = registerShutdown({ process: proc });
    proc.emit("SIGTERM");
    await expect(signal).resolves.toBeUndefined();
    dispose();
  });

  it("escalation resolves on second signal", async () => {
    const proc = makeProcess();
    const { signal, escalation, dispose } = registerShutdown({ process: proc });
    proc.emit("SIGINT");
    await signal;
    proc.emit("SIGINT");
    await expect(escalation).resolves.toBeUndefined();
    dispose();
  });

  it("escalation resolves even if second signal is different", async () => {
    const proc = makeProcess();
    const { signal, escalation, dispose } = registerShutdown({ process: proc });
    proc.emit("SIGINT");
    await signal;
    proc.emit("SIGTERM");
    await expect(escalation).resolves.toBeUndefined();
    dispose();
  });

  it("escalation does not resolve after only one signal", async () => {
    const proc = makeProcess();
    const { signal, escalation, dispose } = registerShutdown({ process: proc });
    proc.emit("SIGINT");
    await signal;

    let settled = false;
    void escalation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    dispose();
  });

  it("dispose() removes listeners so further signals are ignored", () => {
    const proc = makeProcess();
    const { dispose } = registerShutdown({ process: proc });
    dispose();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("dispose() is idempotent", () => {
    const proc = makeProcess();
    const { dispose } = registerShutdown({ process: proc });
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
