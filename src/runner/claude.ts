import { spawn } from "node:child_process";

import { DEFAULT_CLAUDE_SYSTEM_PROMPT } from "./claude-prompt.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

const SUMMARY_TRUNCATE_CHARS = 500;
const DEFAULT_MODEL = "claude-opus-4-7";

export type ClaudeRunnerOptions = {
  id: string;
  model?: string;
  systemPrompt?: string;
  command?: string;
  spawnImpl?: typeof spawn;
};

const CAPABILITIES: RunnerCapabilities = {
  canEdit: true,
  canRunShell: true,
  supportsStructuredOutput: true
};

export class ClaudeRunner implements AgentRunner {
  readonly id: string;
  readonly capabilities = CAPABILITIES;
  readonly #model: string;
  readonly #systemPrompt: string;
  readonly #command: string;
  readonly #spawnImpl: typeof spawn;

  constructor(options: ClaudeRunnerOptions) {
    this.id = options.id;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_CLAUDE_SYSTEM_PROMPT;
    this.#command = options.command ?? "claude";
    this.#spawnImpl = options.spawnImpl ?? spawn;
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    const repoPath = input.repoPaths[0] ?? process.cwd();
    const prompt = renderAgentPrompt(input, { systemPrompt: this.#systemPrompt });
    return this.#spawnWithTimeout(input, repoPath, prompt);
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

      const child = this.#spawnImpl(
        this.#command,
        ["-p", prompt, "--output-format", "json", "--model", this.#model],
        {
          cwd,
          env: {
            ...process.env,
            OTTO_REPO_PATH: cwd,
            OTTO_REPO_PATHS: input.repoPaths.join(":"),
            OTTO_TIMEOUT_MS: String(input.timeoutMs)
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
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
        const summary = truncate(extractClaudeSummary(rawStdout), SUMMARY_TRUNCATE_CHARS);

        if (timedOut) {
          settle({
            success: false,
            summary,
            error: `claude timed out after ${input.timeoutMs.toString()}ms`
          });
          return;
        }

        if (code !== 0) {
          settle({
            success: false,
            summary,
            error: rawStderr.length > 0 ? rawStderr : `claude exited with code ${String(code)}`
          });
          return;
        }

        settle({ success: true, summary });
      });
    });
  }
}

function extractClaudeSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return findStringResult(parsed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

function findStringResult(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["result", "summary", "text", "content"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }

  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
