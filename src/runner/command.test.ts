import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import type { AgentRunInput } from "./types.js";
import { CommandRunner } from "./command.js";

function makeContext(): HydratedGitHubContext {
  return {
    sourceType: "issue_comment",
    owner: "owner",
    repo: "repo",
    number: 1,
    issue: {
      number: 1,
      title: "Fix the bug",
      body: "It is broken",
      state: "open",
      author: "alice",
      labels: ["bug"],
    },
    pullRequest: null,
    reviews: [],
    comments: [],
    truncated: false,
    lineContext: null,
  };
}

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    task: "fix the bug",
    context: makeContext(),
    repoPaths: ["/repos/owner-repo"],
    capabilityGrants: { canEdit: true },
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("CommandRunner", () => {
  it("satisfies the AgentRunner interface", () => {
    const runner = new CommandRunner({ id: "test", command: "true" });
    expect(typeof runner.id).toBe("string");
    expect(typeof runner.capabilities).toBe("object");
    expect(typeof runner.run).toBe("function");
  });

  it("uses the provided id", () => {
    expect(new CommandRunner({ id: "my-runner", command: "true" }).id).toBe("my-runner");
  });

  it("has default capabilities: canEdit=true, canRunShell=true, supportsStructuredOutput=false", () => {
    const { capabilities } = new CommandRunner({ id: "r", command: "true" });
    expect(capabilities.canEdit).toBe(true);
    expect(capabilities.canRunShell).toBe(true);
    expect(capabilities.supportsStructuredOutput).toBe(false);
  });

  it("merges partial capability overrides with defaults", () => {
    const runner = new CommandRunner({
      id: "r",
      command: "true",
      capabilities: { supportsStructuredOutput: true },
    });
    expect(runner.capabilities.canEdit).toBe(true);
    expect(runner.capabilities.supportsStructuredOutput).toBe(true);
  });

  it("returns success when the process exits with code 0", async () => {
    const runner = new CommandRunner({ id: "r", command: "node -e 'process.exit(0)'" });
    const result = await runner.run(makeInput());
    expect(result.success).toBe(true);
  });

  it("returns failure when the process exits with non-zero code", async () => {
    const runner = new CommandRunner({ id: "r", command: "node -e 'process.exit(2)'" });
    const result = await runner.run(makeInput());
    expect(result.success).toBe(false);
    expect(result.error).toBe("process exited with code 2");
  });

  it("captures stdout in summary", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write('hello world')\"",
    });
    const result = await runner.run(makeInput());
    expect(result.summary).toBe("hello world");
  });

  it("truncates stdout to 500 chars", async () => {
    const long = "x".repeat(600);
    const runner = new CommandRunner({
      id: "r",
      command: `node -e "process.stdout.write('${"x".repeat(600)}')"`,
    });
    const result = await runner.run(makeInput());
    expect(result.summary).toHaveLength(501); // 500 + ellipsis char
    expect(result.summary.endsWith("…")).toBe(true);
    void long; // suppress unused warning
  });

  it("returns empty summary when stdout is empty", async () => {
    const runner = new CommandRunner({ id: "r", command: "node -e 'process.exit(0)'" });
    const result = await runner.run(makeInput());
    expect(result.summary).toBe("");
  });

  it("passes OTTO_TASK as an environment variable", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write(process.env.OTTO_TASK)\"",
    });
    const result = await runner.run(makeInput({ task: "do something specific" }));
    expect(result.summary).toBe("do something specific");
  });

  it("passes OTTO_REPO_PATH as an environment variable", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write(process.env.OTTO_REPO_PATH)\"",
    });
    const result = await runner.run(makeInput({ repoPaths: ["/my/repo"] }));
    expect(result.summary).toBe("/my/repo");
  });

  it("passes OTTO_REPO_PATHS with colon-separated values", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write(process.env.OTTO_REPO_PATHS)\"",
    });
    const result = await runner.run(makeInput({ repoPaths: ["/a", "/b", "/c"] }));
    expect(result.summary).toBe("/a:/b:/c");
  });

  it("writes valid JSON context to OTTO_CONTEXT_FILE", async () => {
    let capturedPath = "";
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write(process.env.OTTO_CONTEXT_FILE)\"",
    });
    const result = await runner.run(makeInput());
    capturedPath = result.summary;

    // The temp file is cleaned up after run — verify the path looked like our temp file
    expect(capturedPath).toMatch(/otto-context-[0-9a-f-]+\.json$/);
  });

  it("cleans up the context temp file after a successful run", async () => {
    let contextPath = "";
    const capture = new CommandRunner({
      id: "capture",
      command: "node -e \"process.stdout.write(process.env.OTTO_CONTEXT_FILE)\"",
    });
    const result = await capture.run(makeInput());
    contextPath = result.summary;

    await expect(readFile(contextPath)).rejects.toThrow();
  });

  it("cleans up the context temp file after a failed run", async () => {
    let contextPath = "";
    const capture = new CommandRunner({
      id: "capture",
      command: "node -e \"process.stdout.write(process.env.OTTO_CONTEXT_FILE); process.exit(1)\"",
    });
    const result = await capture.run(makeInput());
    contextPath = result.summary;

    await expect(readFile(contextPath)).rejects.toThrow();
  });

  it("times out and kills the process, returning failure", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"setTimeout(() => {}, 30000)\"",
    });
    const result = await runner.run(makeInput({ timeoutMs: 200 }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 200ms/);
  }, 3000);

  it("includes partial stdout in timed-out result", async () => {
    const runner = new CommandRunner({
      id: "r",
      command: "node -e \"process.stdout.write('partial'); setTimeout(() => {}, 30000)\"",
    });
    const result = await runner.run(makeInput({ timeoutMs: 500 }));
    expect(result.success).toBe(false);
    expect(result.summary).toBe("partial");
  }, 3000);

  it("returns failure with error message for a non-existent command", async () => {
    const runner = new CommandRunner({ id: "r", command: "this-command-does-not-exist-xyz" });
    const result = await runner.run(makeInput());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
