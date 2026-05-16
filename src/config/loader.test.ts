import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./loader.js";

const validYaml = `
github:
  repos:
    - owner/repo
workspace:
  reposDir: /tmp/repos
  worktreesDir: /tmp/worktrees
agent:
  default: claude
  runners:
    claude:
      type: command
      command: claude
`;

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("loadConfig", () => {
  it("loads a valid config from an explicit path", async () => {
    const path = await writeTmp("otto-valid.yaml", validYaml);
    const config = await loadConfig(path);
    expect(config.github.repos).toEqual(["owner/repo"]);
    expect(config.otto.trigger).toBe("otto");
    expect(config.agent.default).toBe("claude");
  });

  it("applies defaults when otto section is absent", async () => {
    const path = await writeTmp("otto-defaults.yaml", validYaml);
    const config = await loadConfig(path);
    expect(config.otto.pollIntervalSeconds).toBe(300);
    expect(config.otto.debounceSeconds).toBe(60);
    expect(config.otto.maxConcurrentRuns).toBe(3);
  });

  it("throws ConfigError when file does not exist", async () => {
    await expect(loadConfig("/nonexistent/path/otto.yaml")).rejects.toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError when no config file is found and no path given", async () => {
    await expect(loadConfig(undefined, [])).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on invalid YAML", async () => {
    const path = await writeTmp("otto-bad.yaml", "{ invalid yaml: [");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on schema validation failure", async () => {
    const badYaml = `
github:
  repos: []
workspace:
  reposDir: /tmp/repos
  worktreesDir: /tmp/worktrees
agent:
  default: claude
  runners: {}
`;
    const path = await writeTmp("otto-schema-fail.yaml", badYaml);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError with a readable message on schema failure", async () => {
    const badYaml = `
github:
  repos: []
workspace:
  reposDir: /tmp/repos
  worktreesDir: /tmp/worktrees
agent:
  default: claude
  runners: {}
`;
    const path = await writeTmp("otto-schema-msg.yaml", badYaml);
    await expect(loadConfig(path)).rejects.toThrow(/invalid/i);
  });

  it("expands tilde in reposDir and worktreesDir", async () => {
    const yaml = `
github:
  repos:
    - owner/repo
workspace:
  reposDir: ~/repos
  worktreesDir: ~/worktrees
agent:
  default: claude
  runners:
    claude:
      type: command
      command: claude
`;
    const path = await writeTmp("otto-tilde.yaml", yaml);
    const config = await loadConfig(path);
    expect(config.workspace.reposDir).not.toContain("~");
    expect(config.workspace.worktreesDir).not.toContain("~");
  });

  it("searches provided paths in order and uses first found", async () => {
    const path = await writeTmp("otto-search.yaml", validYaml);
    const config = await loadConfig(undefined, [
      "/nonexistent/path.yaml",
      path,
    ]);
    expect(config.github.repos).toEqual(["owner/repo"]);
  });
});
