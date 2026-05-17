import type { RunnerConfig } from "../config/index.js";
import { ClaudeRunner, type ClaudeRunnerOptions } from "./claude.js";
import { CommandRunner } from "./command.js";
import type { AgentRunner } from "./types.js";

export function createAgentRunner(id: string, config: RunnerConfig): AgentRunner {
  switch (config.type) {
    case "command":
      return new CommandRunner({ id, command: config.command });
    case "claude": {
      const options: ClaudeRunnerOptions = {
        id,
        model: config.model
      };
      if (config.systemPrompt !== undefined) {
        options.systemPrompt = config.systemPrompt;
      }
      return new ClaudeRunner(options);
    }
  }
}
