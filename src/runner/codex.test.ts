import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import { CodexRunner } from "./codex.js";
import { createAgentRunner } from "./factory.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput } from "./types.js";

let rootDir: string;
let repoDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "otto-codex-runner-"));
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
    sourceType: "pr_conversation_comment",
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
        state: "COMMENTED",
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
    lineContexts: []
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

async function writeFakeCodex(source: string): Promise<string> {
  const path = join(rootDir, "codex");
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("renderAgentPrompt() for Codex", () => {
  it("shares context rendering and asks for Otto JSON", () => {
    const prompt = renderAgentPrompt(makeInput(), {
      systemPrompt: "shared system",
    });

    expect(prompt).toContain("shared system");
    expect(prompt).toContain("Address a review or discussion comment");
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("otto fix this");
    expect(prompt).toContain("Commit your changes");
    expect(prompt).toContain("Otto will open one");
    expect(prompt).toContain("Output only a JSON object");
    expect(prompt).toContain('"commentSummaries"');
  });
});

describe("CodexRunner", () => {
  it("satisfies the AgentRunner interface with JSON-output capabilities", () => {
    const runner = new CodexRunner({ id: "codex", model: "gpt-5.4" });
    expect(runner.id).toBe("codex");
    expect(runner.capabilities).toEqual({
      canEdit: true,
      canRunShell: true,
      supportsStructuredOutput: true
    });
    expect(typeof runner.run).toBe("function");
  });

  it("invokes codex with prompt, cwd, repo env, and inherited env", async () => {
    await writeFakeCodex(`
const args = process.argv.slice(2);
const prompt = args.at(-1);
const payload = {
  args: args.map((arg, index) => index === args.length - 1 ? "<prompt>" : arg),
  promptIncludesTask: prompt.includes("fix the bug"),
  promptRequiresJson: prompt.includes("Output only a JSON object"),
  cwd: process.cwd(),
  repoPath: process.env.OTTO_REPO_PATH,
  repoPaths: process.env.OTTO_REPO_PATHS,
  inheritedEnv: process.env.OTTO_TEST_INHERITED_ENV
};
process.stdout.write(JSON.stringify({ summary: JSON.stringify(payload) }));
`);
    process.env.OTTO_TEST_INHERITED_ENV = "yes";
    const runner = new CodexRunner({ id: "codex", model: "gpt-5.4" });

    const result = await runner.run(makeInput());
    const payload = JSON.parse(result.summary) as {
      args: string[];
      promptIncludesTask: boolean;
      promptRequiresJson: boolean;
      cwd: string;
      repoPath: string;
      repoPaths: string;
      inheritedEnv: string;
    };

    expect(result.success).toBe(true);
    expect(payload.cwd).toBe(await realpath(repoDir));
    expect(payload.repoPath).toBe(repoDir);
    expect(payload.repoPaths).toBe(repoDir);
    expect(payload.args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.4",
      "<prompt>",
    ]);
    expect(payload.promptIncludesTask).toBe(true);
    expect(payload.promptRequiresJson).toBe(true);
    expect(payload.inheritedEnv).toBe("yes");
    delete process.env.OTTO_TEST_INHERITED_ENV;
  });

  it("passes a model override when configured", async () => {
    await writeFakeCodex(`
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  summary: JSON.stringify(args.map((arg, index) => index === args.length - 1 ? "<prompt>" : arg))
}));
`);
    const runner = new CodexRunner({
      id: "codex",
      model: "gpt-5.4",
    });

    const result = await runner.run(makeInput());

    expect(JSON.parse(result.summary) as string[]).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.4",
      "<prompt>",
    ]);
  });

  it("returns success with truncated stdout when JSON parsing fails", async () => {
    const long = "x".repeat(600);
    await writeFakeCodex(`
process.stdout.write("${long}");
`);
    const runner = new CodexRunner({ id: "codex", model: "gpt-5.4" });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.summary).toHaveLength(501);
    expect(result.summary.endsWith("…")).toBe(true);
  });

  it("returns failure with stderr when Codex exits non-zero", async () => {
    await writeFakeCodex(`
process.stderr.write("codex failed");
process.exit(2);
`);
    const runner = new CodexRunner({ id: "codex", model: "gpt-5.4" });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(false);
    expect(result.error).toBe("codex failed");
  });

  it("times out and kills Codex", async () => {
    await writeFakeCodex(`
setTimeout(() => {}, 30000);
`);
    const runner = new CodexRunner({ id: "codex", model: "gpt-5.4" });

    const result = await runner.run(makeInput({ timeoutMs: 100 }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("codex timed out after 100ms");
  }, 5000);
});

describe("createAgentRunner() for Codex", () => {
  it("creates a CodexRunner from codex config", () => {
    const runner = createAgentRunner("codex", {
      type: "codex",
      model: "gpt-5.4",
    });

    expect(runner).toBeInstanceOf(CodexRunner);
    expect(runner.id).toBe("codex");
    expect(runner.capabilities.supportsStructuredOutput).toBe(true);
  });
});
