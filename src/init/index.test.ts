import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInit, type InitFlags } from "./index.js";

type MockResponse = {
  status: number;
  body?: unknown;
};

function mockFetch(responses: MockResponse[]) {
  let call = 0;
  return vi.fn(() => {
    const resp = responses[call++];
    if (resp === undefined) throw new Error("Unexpected fetch call");
    return Promise.resolve(
      new Response(resp.body !== undefined ? JSON.stringify(resp.body) : null, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

function nonInteractiveFlags(overrides: Partial<InitFlags> = {}): InitFlags {
  return {
    token: "ghp_test",
    runner: "claude",
    model: undefined,
    apiKeyEnv: undefined,
    repo: "owner/repo",
    force: false,
    configPath: join(tmpdir(), `otto-init-test-${String(Date.now())}.yaml`),
    ...overrides,
  };
}

describe("runInit", () => {
  let stdout: string;
  let stderr: string;
  let configPath: string;

  beforeEach(() => {
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    configPath = join(tmpdir(), `otto-init-test-${String(Date.now())}.yaml`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (existsSync(configPath)) {
      await rm(configPath);
    }
  });

  it("writes a valid config when all flags are provided", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { status: 200, body: { login: "alice" } },
        { status: 200, body: { full_name: "owner/repo" } },
      ]),
    );

    await runInit(nonInteractiveFlags({ configPath }));

    expect(existsSync(configPath)).toBe(true);
    const content = await readFile(configPath, "utf8");
    expect(content).toContain("owner/repo");
    expect(content).toContain("claude");
    expect(stdout).toContain("Authenticated user: alice");
    expect(stdout).toContain("Watching: owner/repo");
    expect(stdout).toContain("otto start");
  });

  it("writes codex runner config when runner=codex", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { status: 200, body: { login: "alice" } },
        { status: 200, body: { full_name: "owner/repo" } },
      ]),
    );

    await runInit(nonInteractiveFlags({ configPath, runner: "codex", apiKeyEnv: "MY_OPENAI_KEY" }));

    const content = await readFile(configPath, "utf8");
    expect(content).toContain("codex");
    expect(stdout).toContain("OpenAI API key env: MY_OPENAI_KEY");
  });

  it("aborts when config already exists and --force is not set", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(configPath, "existing: true", "utf8");

    await runInit(nonInteractiveFlags({ configPath }));

    expect(stderr).toContain("Config already exists");
    expect(stderr).toContain("--force");
    const content = await readFile(configPath, "utf8");
    expect(content).toBe("existing: true");
  });

  it("overwrites existing config when --force is set", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(configPath, "existing: true", "utf8");

    vi.stubGlobal(
      "fetch",
      mockFetch([
        { status: 200, body: { login: "alice" } },
        { status: 200, body: { full_name: "owner/repo" } },
      ]),
    );

    await runInit(nonInteractiveFlags({ configPath, force: true }));

    const content = await readFile(configPath, "utf8");
    expect(content).not.toContain("existing: true");
    expect(content).toContain("owner/repo");
  });

  it("fails when the token is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ status: 401, body: { message: "Bad credentials" } }]),
    );

    await expect(runInit(nonInteractiveFlags({ configPath }))).rejects.toThrow();
  });

  it("fails when the repo is not found", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        { status: 200, body: { login: "alice" } },
        { status: 404, body: { message: "Not Found" } },
      ]),
    );

    await expect(runInit(nonInteractiveFlags({ configPath }))).rejects.toThrow(/not found/i);
  });

  it("rejects an unknown runner flag", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ status: 200, body: { login: "alice" } }]),
    );

    await expect(runInit(nonInteractiveFlags({ configPath, runner: "unknown" }))).rejects.toThrow(
      /Unknown runner/,
    );
  });
});
