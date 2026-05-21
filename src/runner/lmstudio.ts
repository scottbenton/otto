import { spawn } from "node:child_process";

import { parseOttoJsonOutput, toAgentRunResult, truncateRunnerOutput } from "./output.js";
import { renderAgentPrompt } from "./prompt.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.js";
import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

const LMSTUDIO_COMMAND = "lms";

export type LmStudioRunnerOptions = {
  id: string;
  model: string;
  modelTtlSeconds: number;
  spawnImpl?: typeof spawn;
};

const CAPABILITIES: RunnerCapabilities = {
  canEdit: false,
  canRunShell: false,
  supportsStructuredOutput: true
};

export class LmStudioRunner implements AgentRunner {
  readonly id: string;
  readonly capabilities = CAPABILITIES;
  readonly #model: string;
  readonly #modelTtlSeconds: number;
  readonly #spawnImpl: typeof spawn;

  constructor(options: LmStudioRunnerOptions) {
    this.id = options.id;
    this.#model = options.model;
    this.#modelTtlSeconds = options.modelTtlSeconds;
    this.#spawnImpl = options.spawnImpl ?? spawn;
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    const cwd = input.repoPaths[0] ?? process.cwd();
    const prompt = renderAgentPrompt(input, {
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT
    });
    return this.#spawnWithTimeout(input, cwd, prompt);
  }

  #spawnWithTimeout(input: AgentRunInput, cwd: string, prompt: string): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;

      const settle = (result: AgentRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const args = [
        "chat",
        this.#model,
        "--prompt",
        prompt,
        "--ttl",
        this.#modelTtlSeconds.toString()
      ];
      const child = this.#spawnImpl(LMSTUDIO_COMMAND, args, {
        cwd,
        detached: true,
        env: {
          ...process.env,
          OTTO_REPO_PATH: cwd,
          OTTO_REPO_PATHS: input.repoPaths.join(":"),
          OTTO_TIMEOUT_MS: String(input.timeoutMs)
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // process group already exited
          }
        } else {
          child.kill("SIGKILL");
        }
      }, input.timeoutMs);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });

      child.on("error", (err: Error) => {
        settle({ success: false, summary: "", error: err.message });
      });

      child.on("close", (code) => {
        const rawStdout = Buffer.concat(stdout).toString("utf-8");
        const rawStderr = Buffer.concat(stderr).toString("utf-8").trim();
        const summary = truncateRunnerOutput(rawStdout);
        const parsed = parseOttoJsonOutput(rawStdout, "lmstudio");

        if (timedOut) {
          settle({
            success: false,
            summary,
            error: `lmstudio timed out after ${input.timeoutMs.toString()}ms`
          });
          return;
        }

        if (code !== 0) {
          settle({
            success: false,
            summary,
            error: rawStderr.length > 0 ? rawStderr : `lmstudio exited with code ${String(code)}`
          });
          return;
        }

        if (!parsed.ok) {
          settle({ success: true, summary: parsed.summary });
          return;
        }

        settle(toAgentRunResult(parsed));
      });
    });
  }
}
