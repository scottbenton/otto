import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import { ClaudeRunner } from "./claude.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.js";
import { createAgentRunner } from "./factory.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput } from "./types.js";

let rootDir: string;
let repoDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "otto-claude-runner-"));
  repoDir = join(rootDir, "repo");
  await mkdir(repoDir);
  originalPath = process.env.PATH;
  process.env.PATH = `${rootDir}:${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
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
    lineContexts: [
      {
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
    ]
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
  const path = join(rootDir, "claude");
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("renderAgentPrompt()", () => {
  it("renders task, GitHub context, reviews, comments, line contexts, and git instructions", () => {
    const prompt = renderAgentPrompt(makeInput(), {
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    });

    expect(prompt).toContain("Fix the specific lines of code");
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("otto fix this");
    expect(prompt).toContain("CHANGES_REQUESTED");
    expect(prompt).toContain("src/file.ts");
    expect(prompt).toContain("Full current file content");
    expect(prompt).toContain("Commit your changes");
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("Otto will open one");
    expect(prompt).toContain("Output only a JSON object");
  });

  it("renders required JSON output instructions with comment IDs", () => {
    const prompt = renderAgentPrompt(makeInput(), {
      systemPrompt: "system",
    });

    expect(prompt).toContain("Output only a JSON object");
    expect(prompt).toContain("Comment ID 99 (bob)");
    expect(prompt).toContain('"commentSummaries"');
  });

  it("renders outdated line context as clarification-only work", () => {
    const context = makeContext();
    context.lineContexts = [
      {
        outdated: true,
        id: 124,
        path: "src/old.ts",
        patch: null,
        position: null,
        clarifyMessage: "This comment is outdated."
      }
    ];

    const prompt = renderAgentPrompt(makeInput({ context }), {
      systemPrompt: "system",
    });

    expect(prompt).toContain("Status: outdated");
    expect(prompt).toContain("This comment is outdated.");
    expect(prompt).toContain("instead of guessing");
  });
});

describe("ClaudeRunner", () => {
  it("satisfies the AgentRunner interface with default capabilities", () => {
    const runner = new ClaudeRunner({ id: "claude", model: "claude-sonnet-4-5" });
    expect(runner.id).toBe("claude");
    expect(runner.capabilities).toEqual({
      canEdit: true,
      canRunShell: true,
      supportsStructuredOutput: true
    });
    expect(typeof runner.run).toBe("function");
  });

  it("invokes claude with prompt, model, cwd, and repo env without json output flag", async () => {
    await writeFakeClaude(`
const args = process.argv.slice(2);
const promptIndex = args.indexOf("-p") + 1;
const payload = {
  args: args.map((arg, index) => index === promptIndex ? "<prompt>" : arg),
  promptIncludesTask: args[promptIndex].includes("fix the bug"),
  promptRequiresJson: args[promptIndex].includes("Output only a JSON object"),
  cwd: process.cwd(),
  repoPath: process.env.OTTO_REPO_PATH,
  repoPaths: process.env.OTTO_REPO_PATHS
};
process.stdout.write(JSON.stringify({ summary: JSON.stringify(payload) }));
`);
    const runner = new ClaudeRunner({
      id: "claude",
      model: "claude-test-model"
    });

    const result = await runner.run(makeInput());
    const payload = JSON.parse(result.summary) as {
      args: string[];
      promptIncludesTask: boolean;
      promptRequiresJson: boolean;
      cwd: string;
      repoPath: string;
      repoPaths: string;
    };

    expect(result.success).toBe(true);
    expect(payload.cwd).toBe(await realpath(repoDir));
    expect(payload.repoPath).toBe(repoDir);
    expect(payload.repoPaths).toBe(repoDir);
    expect(payload.args).toEqual([
      "-p",
      "<prompt>",
      "--model",
      "claude-test-model",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(payload.promptIncludesTask).toBe(true);
    expect(payload.promptRequiresJson).toBe(true);
  });

  it("parses structured stdout", async () => {
    await writeFakeClaude(`
process.stdout.write(JSON.stringify({
  summary: "implemented all changes",
  commentSummaries: { "99": "fixed the requested line" }
}));
`);
    const runner = new ClaudeRunner({
      id: "claude",
      model: "claude-sonnet-4-5"
    });

    const result = await runner.run(makeInput());

    expect(result).toEqual({
      success: true,
      summary: "implemented all changes",
      commentSummaries: { 99: "fixed the requested line" }
    });
  });

  it("returns failure with truncated stdout when JSON parsing fails", async () => {
    const long = "x".repeat(600);
    await writeFakeClaude(`
process.stdout.write("${long}");
`);
    const runner = new ClaudeRunner({
      id: "claude",
      model: "claude-sonnet-4-5"
    });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(false);
    expect(result.error).toBe("claude output was not valid JSON");
    expect(result.summary).toHaveLength(501);
    expect(result.summary.endsWith("…")).toBe(true);
  });

  it("returns failure with stderr when Claude exits non-zero", async () => {
    await writeFakeClaude(`
process.stderr.write("claude failed");
process.exit(2);
`);
    const runner = new ClaudeRunner({ id: "claude", model: "claude-sonnet-4-5" });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(false);
    expect(result.error).toBe("claude failed");
  });

  it("times out and kills Claude", async () => {
    await writeFakeClaude(`
setTimeout(() => {}, 30000);
`);
    const runner = new ClaudeRunner({ id: "claude", model: "claude-sonnet-4-5" });

    const result = await runner.run(makeInput({ timeoutMs: 100 }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("claude timed out after 100ms");
  }, 5000);
});

describe("createAgentRunner()", () => {
  it("creates a ClaudeRunner from claude config", () => {
    const runner = createAgentRunner("claude", {
      type: "claude",
      model: "claude-test-model"
    });

    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(runner.id).toBe("claude");
    expect(runner.capabilities.supportsStructuredOutput).toBe(true);
  });
});
