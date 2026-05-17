import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import { ClaudeRunner } from "./claude.js";
import { DEFAULT_CLAUDE_SYSTEM_PROMPT } from "./claude-prompt.js";
import { createAgentRunner } from "./factory.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput } from "./types.js";

let rootDir: string;
let repoDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "otto-claude-runner-"));
  repoDir = join(rootDir, "repo");
  await writeFile(join(rootDir, "placeholder"), "", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repoDir));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function makeContext(): HydratedGitHubContext {
  return {
    sourceType: "pr_line_comment",
    owner: "owner",
    repo: "repo",
    number: 42,
    issue: {
      number: 42,
      title: "Fix the bug",
      body: "It is broken",
      state: "open",
      author: "alice",
      labels: ["bug"]
    },
    pullRequest: {
      baseBranch: "main",
      headBranch: "feature",
      headSha: "abc123"
    },
    reviews: [
      {
        id: 7,
        author: "reviewer",
        state: "CHANGES_REQUESTED",
        body: "Please adjust this.",
        submittedAt: "2026-05-16T00:00:00Z"
      }
    ],
    comments: [
      {
        id: 99,
        author: "bob",
        body: "otto fix this",
        createdAt: "2026-05-16T00:00:01Z"
      }
    ],
    truncated: false,
    lineContext: {
      outdated: false,
      id: 123,
      path: "src/file.ts",
      patch: "@@ patch",
      position: 12,
      currentFile: {
        path: "src/file.ts",
        ref: "abc123",
        content: "export const value = 1;"
      }
    }
  };
}

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    task: "fix the bug",
    context: makeContext(),
    repoPaths: [repoDir],
    capabilityGrants: { canEdit: true, canRunShell: true },
    timeoutMs: 5000,
    ...overrides
  };
}

async function writeFakeClaude(source: string): Promise<string> {
  const path = join(rootDir, "fake-claude");
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("renderAgentPrompt()", () => {
  it("renders task, GitHub context, comments, reviews, line context, and git instructions", () => {
    const prompt = renderAgentPrompt(makeInput(), {
      systemPrompt: DEFAULT_CLAUDE_SYSTEM_PROMPT
    });

    expect(prompt).toContain("## Task");
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("owner/repo#42");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("otto fix this");
    expect(prompt).toContain("CHANGES_REQUESTED");
    expect(prompt).toContain("src/file.ts");
    expect(prompt).toContain("Commit your changes");
    expect(prompt).toContain("Never force-push");
  });

  it("uses the configured system prompt", () => {
    const prompt = renderAgentPrompt(makeInput(), { systemPrompt: "custom system prompt" });
    expect(prompt).toContain("custom system prompt");
  });
});

describe("ClaudeRunner", () => {
  it("satisfies the AgentRunner interface with structured-output capabilities", () => {
    const runner = new ClaudeRunner({ id: "claude" });
    expect(runner.id).toBe("claude");
    expect(runner.capabilities).toEqual({
      canEdit: true,
      canRunShell: true,
      supportsStructuredOutput: true
    });
    expect(typeof runner.run).toBe("function");
  });

  it("invokes claude with prompt, json output, model, cwd, and repo env", async () => {
    const command = await writeFakeClaude(`
const args = process.argv.slice(2);
const payload = {
  args: args.map((arg, index) => index === 1 ? "<prompt>" : arg),
  promptIncludesTask: args[1].includes("fix the bug"),
  cwd: process.cwd(),
  repoPath: process.env.OTTO_REPO_PATH,
  repoPaths: process.env.OTTO_REPO_PATHS
};
process.stdout.write(JSON.stringify({ result: JSON.stringify(payload) }));
`);
    const runner = new ClaudeRunner({
      id: "claude",
      model: "claude-test-model",
      command
    });

    const result = await runner.run(makeInput());
    const payload = JSON.parse(result.summary) as {
      args: string[];
      promptIncludesTask: boolean;
      cwd: string;
      repoPath: string;
      repoPaths: string;
    };

    const realRepoDir = await realpath(repoDir);

    expect(result.success).toBe(true);
    expect(payload.cwd).toBe(realRepoDir);
    expect(payload.repoPath).toBe(repoDir);
    expect(payload.repoPaths).toBe(repoDir);
    expect(payload.args[0]).toBe("-p");
    expect(payload.args[1]).toBe("<prompt>");
    expect(payload.promptIncludesTask).toBe(true);
    expect(payload.args).toContain("--output-format");
    expect(payload.args).toContain("json");
    expect(payload.args).toContain("--model");
    expect(payload.args).toContain("claude-test-model");
  });

  it("extracts summary text from Claude JSON output", async () => {
    const command = await writeFakeClaude(`
process.stdout.write(JSON.stringify({ result: "implemented the change" }));
`);
    const runner = new ClaudeRunner({ id: "claude", command });

    const result = await runner.run(makeInput());

    expect(result).toEqual({ success: true, summary: "implemented the change" });
  });

  it("falls back to raw stdout when output is not Claude JSON", async () => {
    const command = await writeFakeClaude(`
process.stdout.write("plain summary");
`);
    const runner = new ClaudeRunner({ id: "claude", command });

    const result = await runner.run(makeInput());

    expect(result).toEqual({ success: true, summary: "plain summary" });
  });

  it("returns failure with stderr when Claude exits non-zero", async () => {
    const command = await writeFakeClaude(`
process.stderr.write("claude failed");
process.exit(2);
`);
    const runner = new ClaudeRunner({ id: "claude", command });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(false);
    expect(result.error).toBe("claude failed");
  });

  it("times out and kills Claude", async () => {
    const command = await writeFakeClaude(`
setTimeout(() => {}, 30000);
`);
    const runner = new ClaudeRunner({ id: "claude", command });

    const result = await runner.run(makeInput({ timeoutMs: 100 }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("claude timed out after 100ms");
  }, 5000);

  it("passes a system prompt override into the rendered prompt", async () => {
    const command = await writeFakeClaude(`
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ result: args[1] }));
`);
    const runner = new ClaudeRunner({
      id: "claude",
      command,
      systemPrompt: "custom runner instructions"
    });

    const result = await runner.run(makeInput());

    expect(result.summary).toContain("custom runner instructions");
  });
});

describe("createAgentRunner()", () => {
  it("creates a ClaudeRunner from claude config", () => {
    const runner = createAgentRunner("claude", {
      type: "claude",
      model: "claude-test-model"
    });

    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(runner.id).toBe("claude");
  });
});
