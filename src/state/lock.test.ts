import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LockError, acquireLock } from "./lock.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = join(tmpdir(), `otto-lock-test-${String(Date.now())}`);
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("acquireLock()", () => {
  it("acquires the lock when no lock file exists", async () => {
    const release = await acquireLock(stateDir);
    await expect(release()).resolves.toBeUndefined();
  });

  it("writes the current PID to the lock file", async () => {
    const release = await acquireLock(stateDir);
    const { readFile } = await import("node:fs/promises");
    const contents = await readFile(join(stateDir, "otto.lock"), "utf8");
    expect(Number(contents.trim())).toBe(process.pid);
    await release();
  });

  it("removes the lock file on release", async () => {
    const release = await acquireLock(stateDir);
    await release();
    const { access } = await import("node:fs/promises");
    await expect(access(join(stateDir, "otto.lock"))).rejects.toThrow();
  });

  it("acquires over a stale lock (process not running)", async () => {
    // PID 2147483647 is the max int32 and almost certainly not running
    await writeFile(join(stateDir, "otto.lock"), "2147483647", "utf8");
    const release = await acquireLock(stateDir);
    await release();
  });

  it("throws LockError when a live process holds the lock", async () => {
    // current process is definitely running
    await writeFile(join(stateDir, "otto.lock"), String(process.pid), "utf8");
    await expect(acquireLock(stateDir)).rejects.toThrow(LockError);
  });

  it("LockError message includes the blocking PID", async () => {
    await writeFile(join(stateDir, "otto.lock"), String(process.pid), "utf8");
    await expect(acquireLock(stateDir)).rejects.toThrow(
      new RegExp(String(process.pid)),
    );
  });
});
