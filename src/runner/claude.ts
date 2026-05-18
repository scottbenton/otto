import { spawn } from "node:child_process";

import { DEFAULT_CLAUDE_SYSTEM_PROMPT } from "./claude-prompt.js";
import { renderAgentPrompt } from "./prompt.js";
import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

const SUMMARY_TRUNCATE_CHARS = 500;
const CLAUDE_COMMAND = "claude";

export type ClaudeRunnerOptions = {
  id: string;
  model: string;
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
  readonly #spawnImpl: typeof spawn;

  constructor(options: ClaudeRunnerOptions) {
    this.id = options.id;
    this.#model = options.model;
    this.#spawnImpl = options.spawnImpl ?? spawn;
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    const cwd = input.repoPaths[0] ?? process.cwd();
    const prompt = renderAgentPrompt(input, {
      systemPrompt: DEFAULT_CLAUDE_SYSTEM_PROMPT
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

      const child = this.#spawnImpl(CLAUDE_COMMAND, ["-p", prompt, "--model", this.#model], {
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
        const parsed = parseClaudeOutput(rawStdout);

        if (timedOut) {
          settle({
            success: false,
            summary: parsed.summary,
            error: `claude timed out after ${input.timeoutMs.toString()}ms`
          });
          return;
        }

        if (code !== 0) {
          settle({
            success: false,
            summary: parsed.summary,
            error: rawStderr.length > 0 ? rawStderr : `claude exited with code ${String(code)}`
          });
          return;
        }

        if (!parsed.ok) {
          settle({
            success: false,
            summary: parsed.summary,
            error: parsed.error
          });
          return;
        }

        const result: AgentRunResult = {
          success: true,
          summary: parsed.summary
        };
        if (parsed.commentSummaries !== undefined) {
          result.commentSummaries = parsed.commentSummaries;
        }
        settle(result);
      });
    });
  }
}

type ParsedClaudeOutput =
  | { ok: true; summary: string; commentSummaries?: Record<number, string> }
  | { ok: false; summary: string; error: string };

function parseClaudeOutput(raw: string): ParsedClaudeOutput {
  const trimmed = raw.trim();
  const fallbackSummary = truncate(trimmed, SUMMARY_TRUNCATE_CHARS);
  if (trimmed.length === 0) {
    return {
      ok: false,
      summary: "",
      error: "claude output was empty; expected Otto JSON"
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isStructuredOutput(parsed)) {
      return {
        ok: false,
        summary: fallbackSummary,
        error: "claude output did not match Otto JSON schema"
      };
    }
    const result: ParsedClaudeOutput = {
      ok: true,
      summary: parsed.summary
    };
    if (parsed.commentSummaries !== undefined) {
      result.commentSummaries = Object.fromEntries(
        Object.entries(parsed.commentSummaries).map(([key, value]) => [Number(key), value])
      );
    }
    return result;
  } catch {
    return {
      ok: false,
      summary: fallbackSummary,
      error: "claude output was not valid JSON"
    };
  }
}

function isStructuredOutput(
  value: unknown
): value is { summary: string; commentSummaries?: Record<string, string> } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string") return false;
  if (record.commentSummaries === undefined) return true;
  if (typeof record.commentSummaries !== "object" || record.commentSummaries === null) {
    return false;
  }
  return Object.values(record.commentSummaries).every((summary) => typeof summary === "string");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
