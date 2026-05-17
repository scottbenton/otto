import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

const STDOUT_TRUNCATE_CHARS = 500;

export type CommandRunnerOptions = {
  id: string;
  command: string;
  capabilities?: Partial<RunnerCapabilities>;
};

const DEFAULT_CAPABILITIES: RunnerCapabilities = {
  canEdit: true,
  canRunShell: true,
  supportsStructuredOutput: false,
};

export class CommandRunner implements AgentRunner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  readonly #command: string;

  constructor(opts: CommandRunnerOptions) {
    this.id = opts.id;
    this.#command = opts.command;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const contextFile = join(tmpdir(), `otto-context-${randomUUID()}.json`);
    try {
      await writeFile(contextFile, JSON.stringify(input.context), "utf-8");
      return await this.#spawnWithTimeout(input, contextFile);
    } finally {
      await rm(contextFile, { force: true });
    }
  }

  #spawnWithTimeout(input: AgentRunInput, contextFile: string): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;

      const settle = (result: AgentRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OTTO_TASK: input.task,
        OTTO_CONTEXT_FILE: contextFile,
        OTTO_REPO_PATH: input.repoPaths[0] ?? "",
        OTTO_REPO_PATHS: input.repoPaths.join(":"),
        OTTO_TIMEOUT_MS: String(input.timeoutMs),
      };

      // detached: true places the shell and all its children in their own process
      // group so we can kill them all atomically via process.kill(-pgid, 'SIGKILL').
      // Without this, killing the shell alone leaves grandchildren holding the
      // stdout pipe open, which prevents the 'close' event from firing.
      const child = spawn(this.#command, [], {
        shell: true,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "inherit"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // process group already exited
          }
        }
      }, input.timeoutMs);

      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });

      child.on("error", (err: Error) => {
        settle({ success: false, summary: "", error: err.message });
      });

      child.on("close", (code) => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const summary = truncate(raw, STDOUT_TRUNCATE_CHARS);

        if (timedOut) {
          settle({
            success: false,
            summary,
            error: `process timed out after ${input.timeoutMs.toString()}ms`,
          });
          return;
        }

        if (code !== 0) {
          settle({
            success: false,
            summary,
            error: `process exited with code ${String(code)}`,
          });
          return;
        }

        settle({ success: true, summary });
      });
    });
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
