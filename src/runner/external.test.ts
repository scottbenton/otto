import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import { createAgentRunner } from "./factory.js";
import { ExternalRunner } from "./external.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput } from "./types.js";

let rootDir: string;
let repoDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "otto-external-runner-"));
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
      htmlUrl: "https://github.com/owner/repo/pull/42",
      baseBranch: "main",
      headBranch: "feature",
      headSha: "abc123"
    },
    reviews: [],
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
    capabilityGrants: { supportsStructuredOutput: false },
    timeoutMs: 5000,
    ...overrides
  };
}

async function writeFakeCommand(name: string, source: string): Promise<string> {
  const path = join(rootDir, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("renderAgentPrompt() for external runners", () => {
  it("shares context rendering and asks for Otto JSON", () => {
    const prompt = renderAgentPrompt(makeInput(), {
      systemPrompt: "shared system"
    });

    expect(prompt).toContain("shared system");
    expect(prompt).toContain("Address a review or discussion comment");
    expect(prompt).toContain("owner/repo");
    expect(prompt).toContain("otto fix this");
    expect(prompt).toContain("Output only a JSON object");
    expect(prompt).toContain('"commentSummaries"');
  });
});

describe("ExternalRunner", () => {
  it("satisfies the AgentRunner interface with editing capabilities", () => {
    const runner = new ExternalRunner({
      id: "aider",
      command: "aider",
      args: ["--message-file", "{{promptFile}}"]
    });
    expect(runner.id).toBe("aider");
    expect(runner.capabilities).toEqual({
      canEdit: true,
      canRunShell: true,
      supportsStructuredOutput: false
    });
    expect(typeof runner.run).toBe("function");
  });

  it("invokes the configured command with templated args, cwd, env, and inherited env", async () => {
    await writeFakeCommand("external-agent", `
const args = process.argv.slice(2);
const promptPath = args[args.indexOf("--message-file") + 1];
const contextPath = args[args.indexOf("--context") + 1];
const prompt = require("node:fs").readFileSync(promptPath, "utf8");
const context = JSON.parse(require("node:fs").readFileSync(contextPath, "utf8"));
const payload = {
  args: args.map((arg) => arg === promptPath ? "<promptFile>" : arg === contextPath ? "<contextFile>" : arg),
  promptIncludesTask: prompt.includes("fix the bug"),
  promptRequiresJson: prompt.includes("Output only a JSON object"),
  contextOwner: context.owner,
  cwd: process.cwd(),
  promptFileEnv: process.env.OTTO_PROMPT_FILE,
  contextFileEnv: process.env.OTTO_CONTEXT_FILE,
  repoPath: process.env.OTTO_REPO_PATH,
  repoPaths: process.env.OTTO_REPO_PATHS,
  inheritedEnv: process.env.OTTO_TEST_INHERITED_ENV
};
process.stdout.write(JSON.stringify({ summary: JSON.stringify(payload) }));
`);
    process.env.OTTO_TEST_INHERITED_ENV = "yes";
    const runner = new ExternalRunner({
      id: "aider",
      command: "external-agent",
      args: ["--message-file", "{{promptFile}}", "--context", "{{contextFile}}"]
    });

    const result = await runner.run(makeInput());
    const payload = JSON.parse(result.summary) as {
      args: string[];
      promptIncludesTask: boolean;
      promptRequiresJson: boolean;
      contextOwner: string;
      cwd: string;
      promptFileEnv: string;
      contextFileEnv: string;
      repoPath: string;
      repoPaths: string;
      inheritedEnv: string;
    };

    expect(result.success).toBe(true);
    expect(payload.cwd).toBe(await realpath(repoDir));
    expect(payload.repoPath).toBe(repoDir);
    expect(payload.repoPaths).toBe(repoDir);
    expect(payload.promptFileEnv).toMatch(/otto-prompt-[0-9a-f-]+\.md$/);
    expect(payload.contextFileEnv).toMatch(/otto-context-[0-9a-f-]+\.json$/);
    expect(payload.args).toEqual(["--message-file", "<promptFile>", "--context", "<contextFile>"]);
    expect(payload.promptIncludesTask).toBe(true);
    expect(payload.promptRequiresJson).toBe(true);
    expect(payload.contextOwner).toBe("owner");
    expect(payload.inheritedEnv).toBe("yes");
    delete process.env.OTTO_TEST_INHERITED_ENV;
  });

  it("returns success with an empty summary when stdout is not Otto JSON", async () => {
    await writeFakeCommand("external-agent", `
process.stdout.write("agent logs that should not become a public summary");
`);
    const runner = new ExternalRunner({ id: "aider", command: "external-agent" });

    const result = await runner.run(makeInput());

    expect(result).toEqual({ success: true, summary: "" });
  });

  it("returns failure with stderr when the external runner exits non-zero", async () => {
    await writeFakeCommand("external-agent", `
process.stderr.write("agent failed");
process.exit(2);
`);
    const runner = new ExternalRunner({ id: "aider", command: "external-agent" });

    const result = await runner.run(makeInput());

    expect(result.success).toBe(false);
    expect(result.error).toBe("agent failed");
  });

  it("times out and kills the external runner", async () => {
    await writeFakeCommand("external-agent", `
setTimeout(() => {}, 30000);
`);
    const runner = new ExternalRunner({ id: "aider", command: "external-agent" });

    const result = await runner.run(makeInput({ timeoutMs: 100 }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("external runner timed out after 100ms");
  }, 5000);

  it("cleans up prompt and context files after the run", async () => {
    await writeFakeCommand("external-agent", `
process.stdout.write(JSON.stringify({
  summary: JSON.stringify({
    promptFile: process.env.OTTO_PROMPT_FILE,
    contextFile: process.env.OTTO_CONTEXT_FILE
  })
}));
`);
    const runner = new ExternalRunner({ id: "aider", command: "external-agent" });
    const result = await runner.run(makeInput());
    const payload = JSON.parse(result.summary) as { promptFile: string; contextFile: string };

    await expect(readFile(payload.promptFile)).rejects.toThrow();
    await expect(readFile(payload.contextFile)).rejects.toThrow();
  });
});

describe("createAgentRunner() for external runners", () => {
  it("creates an ExternalRunner from external config", () => {
    const runner = createAgentRunner("aider", {
      type: "external",
      command: "uvx",
      args: ["--from", "aider-chat", "aider", "--message-file", "{{promptFile}}"]
    });

    expect(runner).toBeInstanceOf(ExternalRunner);
    expect(runner.id).toBe("aider");
    expect(runner.capabilities.canEdit).toBe(true);
  });
});
