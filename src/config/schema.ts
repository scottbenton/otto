import { z } from "zod";

const repoSlugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const CommandRunnerConfigSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
  })
  .strict();

const ClaudeRunnerConfigSchema = z
  .object({
    type: z.literal("claude"),
    model: z.string().min(1).default("claude-sonnet-4-5"),
  })
  .strict();

const CodexRunnerConfigSchema = z
  .object({
    type: z.literal("codex"),
    model: z.string().min(1).default("gpt-5.4"),
  })
  .strict();

const LmStudioRunnerConfigSchema = z
  .object({
    type: z.literal("lmstudio"),
    model: z.string().min(1),
    modelTtlSeconds: z.number().int().min(0).default(3600),
  })
  .strict();

const RunnerConfigSchema = z.discriminatedUnion("type", [
  CommandRunnerConfigSchema,
  ClaudeRunnerConfigSchema,
  CodexRunnerConfigSchema,
  LmStudioRunnerConfigSchema,
]);

export const OttoConfigSchema = z.object({
  otto: z.object({
    trigger: z.string().min(1).default("otto"),
    pollIntervalSeconds: z.number().int().min(30).default(60),
    debounceSeconds: z.number().int().min(0).default(60),
    maxConcurrentRuns: z.number().int().min(1).default(3),
  }),
  github: z.object({
    tokenEnvVar: z.string().min(1).default("GITHUB_TOKEN"),
    repos: z
      .array(z.string().regex(repoSlugPattern, "must be owner/repo format"))
      .min(1, "at least one repo is required"),
  }),
  workspace: z.object({
    reposDir: z.string().min(1),
    worktreesDir: z.string().min(1),
  }),
  agent: z.object({
    default: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).default(600),
    runners: z.record(z.string(), RunnerConfigSchema),
  }),
});

export type OttoConfig = z.infer<typeof OttoConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
