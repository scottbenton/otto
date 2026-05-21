import type { RunnerConfig } from "../config/index.js";
import { ClaudeRunner } from "./claude.js";
import { CommandRunner } from "./command.js";
import { CodexRunner } from "./codex.js";
import { LmStudioRunner } from "./lmstudio.js";
import type { AgentRunner } from "./types.js";

export function createAgentRunner(id: string, config: RunnerConfig): AgentRunner {
  switch (config.type) {
    case "command":
      return new CommandRunner({ id, command: config.command });
    case "claude": {
      return new ClaudeRunner({
        id,
        model: config.model
      });
    }
    case "codex": {
      return new CodexRunner({ id, model: config.model });
    }
    case "lmstudio": {
      return new LmStudioRunner({
        id,
        model: config.model,
        modelTtlSeconds: config.modelTtlSeconds
      });
    }
  }
}
