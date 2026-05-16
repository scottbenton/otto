import { describe, expect, it } from "vitest";

import { OttoConfigSchema } from "./schema.js";

const validConfig = {
  github: {
    tokenEnv: "GITHUB_TOKEN",
    repos: ["owner/repo"],
  },
  workspace: {
    reposDir: "/home/user/repos",
    worktreesDir: "/home/user/worktrees",
  },
  agent: {
    default: "claude",
    runners: {
      claude: { type: "command", command: "claude" },
    },
  },
};

describe("OttoConfigSchema", () => {
  it("parses a complete valid config", () => {
    const config = {
      ...validConfig,
      otto: {
        trigger: "otto",
        pollIntervalSeconds: 300,
        debounceSeconds: 60,
        maxConcurrentRuns: 3,
      },
    };
    const result = OttoConfigSchema.parse(config);
    expect(result.otto.trigger).toBe("otto");
    expect(result.otto.pollIntervalSeconds).toBe(300);
    expect(result.github.repos).toEqual(["owner/repo"]);
    expect(result.agent.runners.claude).toEqual({
      type: "command",
      command: "claude",
    });
  });

  it("applies otto defaults when otto section is omitted", () => {
    const result = OttoConfigSchema.parse(validConfig);
    expect(result.otto.trigger).toBe("otto");
    expect(result.otto.pollIntervalSeconds).toBe(300);
    expect(result.otto.debounceSeconds).toBe(60);
    expect(result.otto.maxConcurrentRuns).toBe(3);
  });

  it("applies otto field defaults when section is present but fields are missing", () => {
    const result = OttoConfigSchema.parse({ ...validConfig, otto: {} });
    expect(result.otto.trigger).toBe("otto");
    expect(result.otto.pollIntervalSeconds).toBe(300);
  });

  it("applies github.tokenEnv default", () => {
    const config = {
      ...validConfig,
      github: { repos: ["owner/repo"] },
    };
    const result = OttoConfigSchema.parse(config);
    expect(result.github.tokenEnv).toBe("GITHUB_TOKEN");
  });

  it("applies agent.timeoutSeconds default", () => {
    const result = OttoConfigSchema.parse(validConfig);
    expect(result.agent.timeoutSeconds).toBe(600);
  });

  it("rejects empty github.repos", () => {
    const config = { ...validConfig, github: { repos: [] } };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects malformed repo slug", () => {
    const config = {
      ...validConfig,
      github: { repos: ["not-a-valid-slug"] },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects repo slug with more than one slash", () => {
    const config = {
      ...validConfig,
      github: { repos: ["owner/repo/extra"] },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects missing workspace.reposDir", () => {
    const config = {
      ...validConfig,
      workspace: { worktreesDir: "/tmp/wt" },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects missing workspace.worktreesDir", () => {
    const config = {
      ...validConfig,
      workspace: { reposDir: "/tmp/repos" },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects missing agent.default", () => {
    const config = {
      ...validConfig,
      agent: { runners: { claude: { type: "command", command: "claude" } } },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects pollIntervalSeconds below minimum", () => {
    const config = {
      ...validConfig,
      otto: { pollIntervalSeconds: 5 },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("rejects maxConcurrentRuns below minimum", () => {
    const config = {
      ...validConfig,
      otto: { maxConcurrentRuns: 0 },
    };
    expect(() => OttoConfigSchema.parse(config)).toThrow();
  });

  it("accepts multiple repos", () => {
    const config = {
      ...validConfig,
      github: { repos: ["owner/repo1", "owner/repo2"] },
    };
    const result = OttoConfigSchema.parse(config);
    expect(result.github.repos).toHaveLength(2);
  });

  it("accepts multiple runners", () => {
    const config = {
      ...validConfig,
      agent: {
        default: "claude",
        runners: {
          claude: { type: "command", command: "claude" },
          codex: { type: "command", command: "codex" },
        },
      },
    };
    const result = OttoConfigSchema.parse(config);
    expect(Object.keys(result.agent.runners)).toHaveLength(2);
  });
});
