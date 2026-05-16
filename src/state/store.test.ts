import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateStore } from "./store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let stateDir: string;

beforeEach(async () => {
  stateDir = join(tmpdir(), `otto-test-${String(Date.now())}`);
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("StateStore.load()", () => {
  it("creates a fresh state file with a UUID when none exists", async () => {
    const store = await StateStore.load(stateDir);
    expect(store.machineId).toMatch(UUID_RE);
  });

  it("persists the state file on first load", async () => {
    await StateStore.load(stateDir);
    // Verify file contents are valid JSON with expected shape
    const raw = await readFile(join(stateDir, "state.json"), "utf8");
    expect(raw).toContain('"machineId"');
  });

  it("reuses the existing machine UUID on reload", async () => {
    const first = await StateStore.load(stateDir);
    const second = await StateStore.load(stateDir);
    expect(second.machineId).toBe(first.machineId);
  });

  it("initialises lastPolled and seenCommentIds as empty records", async () => {
    const store = await StateStore.load(stateDir);
    expect(store.getLastPolled("owner/repo")).toBeUndefined();
    expect(store.getSeenCommentIds("owner/repo")).toEqual([]);
  });
});

describe("StateStore updates", () => {
  it("setLastPolled saves and recalls a timestamp", async () => {
    const store = await StateStore.load(stateDir);
    const ts = "2024-01-01T00:00:00Z";
    await store.setLastPolled("owner/repo", ts);
    expect(store.getLastPolled("owner/repo")).toBe(ts);
  });

  it("addSeenCommentIds accumulates IDs", async () => {
    const store = await StateStore.load(stateDir);
    await store.addSeenCommentIds("owner/repo", [1, 2]);
    await store.addSeenCommentIds("owner/repo", [3]);
    expect(store.getSeenCommentIds("owner/repo")).toEqual([1, 2, 3]);
  });

  it("addSeenCommentIds deduplicates IDs", async () => {
    const store = await StateStore.load(stateDir);
    await store.addSeenCommentIds("owner/repo", [1, 2]);
    await store.addSeenCommentIds("owner/repo", [2, 3]);
    expect(store.getSeenCommentIds("owner/repo")).toEqual([1, 2, 3]);
  });

  it("persists changes across reload", async () => {
    const store = await StateStore.load(stateDir);
    await store.setLastPolled("owner/repo", "2024-06-01T00:00:00Z");
    await store.addSeenCommentIds("owner/repo", [42]);

    const reloaded = await StateStore.load(stateDir);
    expect(reloaded.getLastPolled("owner/repo")).toBe("2024-06-01T00:00:00Z");
    expect(reloaded.getSeenCommentIds("owner/repo")).toEqual([42]);
  });
});

describe("StateStore atomic write", () => {
  it("leaves no .tmp file after save", async () => {
    const store = await StateStore.load(stateDir);
    await store.setLastPolled("owner/repo", "2024-01-01T00:00:00Z");

    await expect(
      readFile(join(stateDir, "state.json.tmp"), "utf8"),
    ).rejects.toThrow();
  });
});
