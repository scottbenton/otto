import type { RunnerConfig } from "../config/index.js";
import { ClaudeRunner } from "./claude.js";
import { CommandRunner } from "./command.js";
import { CodexRunner } from "./codex.js";
import { ExternalRunner } from "./external.js";
import type { AgentRunner } from "./types.js";

export function createAgentRunner(id: string, config: RunnerConfig): AgentRunner {
  switch (config.type) {
    case "command":
      return new CommandRunner({ id, command: config.command });
    case "external":
      return new ExternalRunner({ id, command: config.command, args: config.args });
    case "claude": {
      return new ClaudeRunner({
        id,
        model: config.model
      });
    }
    case "codex": {
      return new CodexRunner({ id, model: config.model });
    }
  }
}
