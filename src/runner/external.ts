import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOttoJsonOutput, toAgentRunResult, truncateRunnerOutput } from "./output.js";
import { renderAgentPrompt } from "./prompt.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.js";
import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

const CAPABILITIES: RunnerCapabilities = {
  canEdit: true,
  canRunShell: true,
  supportsStructuredOutput: false
};

export type ExternalRunnerOptions = {
  id: string;
  command: string;
  args?: string[];
  spawnImpl?: typeof spawn;
};

export class ExternalRunner implements AgentRunner {
  readonly id: string;
  readonly capabilities = CAPABILITIES;
  readonly #command: string;
  readonly #args: string[];
  readonly #spawnImpl: typeof spawn;

  constructor(options: ExternalRunnerOptions) {
    this.id = options.id;
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#spawnImpl = options.spawnImpl ?? spawn;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const prompt = renderAgentPrompt(input, {
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT
    });
    const runId = randomUUID();
    const contextFile = join(tmpdir(), `otto-context-${runId}.json`);
    const promptFile = join(tmpdir(), `otto-prompt-${runId}.md`);

    try {
      await Promise.all([
        writeFile(contextFile, JSON.stringify(input.context), "utf-8"),
        writeFile(promptFile, prompt, "utf-8")
      ]);
      return await this.#spawnWithTimeout(input, prompt, promptFile, contextFile);
    } finally {
      await Promise.all([
        rm(contextFile, { force: true }),
        rm(promptFile, { force: true })
      ]);
    }
  }

  #spawnWithTimeout(
    input: AgentRunInput,
    prompt: string,
    promptFile: string,
    contextFile: string
  ): Promise<AgentRunResult> {
    return new Promise<AgentRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      const cwd = input.repoPaths[0] ?? process.cwd();
      const templateValues = {
        prompt,
        promptFile,
        contextFile,
        task: input.task,
        repoPath: cwd,
        repoPaths: input.repoPaths.join(":")
      };
      const args = this.#args.map((arg) => replaceTemplates(arg, templateValues));

      const settle = (result: AgentRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const child = this.#spawnImpl(this.#command, args, {
        cwd,
        detached: true,
        env: {
          ...process.env,
          OTTO_TASK: input.task,
          OTTO_CONTEXT_FILE: contextFile,
          OTTO_PROMPT_FILE: promptFile,
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

        if (timedOut) {
          settle({
            success: false,
            summary,
            error: `external runner timed out after ${input.timeoutMs.toString()}ms`
          });
          return;
        }

        if (code !== 0) {
          settle({
            success: false,
            summary,
            error: rawStderr.length > 0 ? rawStderr : `external runner exited with code ${String(code)}`
          });
          return;
        }

        const parsed = parseOttoJsonOutput(rawStdout, "external runner");
        if (parsed.ok) {
          settle(toAgentRunResult(parsed));
          return;
        }

        settle({ success: true, summary: "" });
      });
    });
  }
}

function replaceTemplates(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });
}
