import type { AgentRunResult } from "./types.js";

const SUMMARY_TRUNCATE_CHARS = 500;

export type ParsedRunnerOutput =
  | { ok: true; summary: string; commentSummaries?: Record<number, string> }
  | { ok: false; summary: string; error: string };

// Matches an optional ```json or ``` fence around the content.
const FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

// Matches the first {...} block in a string, for extracting JSON from prose.
const JSON_OBJECT_RE = /\{[\s\S]*\}/;

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = FENCE_RE.exec(trimmed);
  if (fenceMatch?.[1] !== undefined) return fenceMatch[1].trim();
  const objectMatch = JSON_OBJECT_RE.exec(trimmed);
  if (objectMatch !== null) return objectMatch[0];
  return trimmed;
}

export function parseOttoJsonOutput(raw: string, runnerName: string): ParsedRunnerOutput {
  const trimmed = raw.trim();
  const fallbackSummary = truncate(trimmed, SUMMARY_TRUNCATE_CHARS);
  if (trimmed.length === 0) {
    return {
      ok: false,
      summary: "",
      error: `${runnerName} output was empty; expected Otto JSON`
    };
  }

  try {
    const parsed = JSON.parse(extractJsonCandidate(trimmed)) as unknown;
    if (!isStructuredOutput(parsed)) {
      return {
        ok: false,
        summary: fallbackSummary,
        error: `${runnerName} output did not match Otto JSON schema`
      };
    }

    const result: ParsedRunnerOutput = {
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
      error: `${runnerName} output was not valid JSON`
    };
  }
}

export function truncateRunnerOutput(text: string): string {
  return truncate(text, SUMMARY_TRUNCATE_CHARS);
}

export function toAgentRunResult(parsed: Extract<ParsedRunnerOutput, { ok: true }>): AgentRunResult {
  const result: AgentRunResult = {
    success: true,
    summary: parsed.summary
  };
  if (parsed.commentSummaries !== undefined) {
    result.commentSummaries = parsed.commentSummaries;
  }
  return result;
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
