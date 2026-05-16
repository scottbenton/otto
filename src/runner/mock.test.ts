import { describe, expect, it } from "vitest";

import type { HydratedGitHubContext } from "../context/types.js";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "./types.js";
import { MockRunner } from "./mock.js";

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
    timeoutMs: 30000,
    ...overrides,
  };
}

describe("MockRunner", () => {
  it("satisfies the AgentRunner interface", () => {
    const runner: AgentRunner = new MockRunner();
    expect(typeof runner.id).toBe("string");
    expect(typeof runner.capabilities).toBe("object");
    expect(typeof runner.run).toBe("function");
  });

  it("uses 'mock' as the default id", () => {
    expect(new MockRunner().id).toBe("mock");
  });

  it("accepts a custom id", () => {
    expect(new MockRunner({ id: "my-runner" }).id).toBe("my-runner");
  });

  it("has default capabilities: canEdit=true, canRunShell=false, supportsStructuredOutput=false", () => {
    const { capabilities } = new MockRunner();
    expect(capabilities.canEdit).toBe(true);
    expect(capabilities.canRunShell).toBe(false);
    expect(capabilities.supportsStructuredOutput).toBe(false);
  });

  it("merges partial capability overrides with defaults", () => {
    const runner = new MockRunner({ capabilities: { canRunShell: true } });
    expect(runner.capabilities.canEdit).toBe(true);
    expect(runner.capabilities.canRunShell).toBe(true);
    expect(runner.capabilities.supportsStructuredOutput).toBe(false);
  });

  it("returns the default success result when no result configured", async () => {
    const result = await new MockRunner().run(makeInput());
    expect(result.success).toBe(true);
    expect(typeof result.summary).toBe("string");
  });

  it("returns a fixed result object when configured", async () => {
    const fixed: AgentRunResult = { success: false, summary: "failed", error: "oops" };
    const result = await new MockRunner({ result: fixed }).run(makeInput());
    expect(result).toEqual(fixed);
  });

  it("calls the result factory function with the input when configured", async () => {
    const inputs: AgentRunInput[] = [];
    const runner = new MockRunner({
      result: (input) => {
        inputs.push(input);
        return { success: true, summary: `ran: ${input.task}` };
      },
    });
    const input = makeInput({ task: "do something" });
    const result = await runner.run(input);
    expect(result.summary).toBe("ran: do something");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe(input);
  });

  it("records every call in the calls array", async () => {
    const runner = new MockRunner();
    const a = makeInput({ task: "first" });
    const b = makeInput({ task: "second" });
    await runner.run(a);
    await runner.run(b);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toBe(a);
    expect(runner.calls[1]).toBe(b);
  });

  it("starts with an empty calls array", () => {
    expect(new MockRunner().calls).toHaveLength(0);
  });

  it("includes branch and commits in result when configured", async () => {
    const fixed: AgentRunResult = {
      success: true,
      summary: "done",
      branch: "fix/issue-1",
      commits: ["abc123", "def456"],
    };
    const result = await new MockRunner({ result: fixed }).run(makeInput());
    expect(result.branch).toBe("fix/issue-1");
    expect(result.commits).toEqual(["abc123", "def456"]);
  });
});
