import type { HydratedGitHubContext } from "../context/types.js";

export type RunnerCapabilities = {
  canEdit: boolean;
  canRunShell: boolean;
  supportsStructuredOutput: boolean;
};

export type AgentRunInput = {
  task: string;
  context: HydratedGitHubContext;
  repoPaths: string[];
  capabilityGrants: Partial<RunnerCapabilities>;
  timeoutMs: number;
};

export type AgentRunResult = {
  success: boolean;
  summary: string;
  commentSummaries?: Record<number, string>;
  branch?: string;
  commits?: string[];
  error?: string;
};

export type AgentRunner = {
  id: string;
  capabilities: RunnerCapabilities;
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
