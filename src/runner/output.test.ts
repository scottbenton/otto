import { describe, expect, it } from "vitest";

import { parseOttoJsonOutput } from "./output.js";

const VALID = JSON.stringify({ summary: "did the thing" });
const VALID_WITH_SUMMARIES = JSON.stringify({
  summary: "did the thing",
  commentSummaries: { "42": "fixed line" }
});
const VALID_WITH_PR_BODY = JSON.stringify({
  summary: "did the thing",
  prBody: "## What was done\n\nFixed the bug.\n\nCloses #7"
});

describe("parseOttoJsonOutput()", () => {
  it("parses bare valid JSON", () => {
    const result = parseOttoJsonOutput(VALID, "claude");
    expect(result).toEqual({ ok: true, summary: "did the thing" });
  });

  it("parses commentSummaries and converts keys to numbers", () => {
    const result = parseOttoJsonOutput(VALID_WITH_SUMMARIES, "claude");
    expect(result).toEqual({
      ok: true,
      summary: "did the thing",
      commentSummaries: { 42: "fixed line" }
    });
  });

  it("parses optional PR body output", () => {
    const result = parseOttoJsonOutput(VALID_WITH_PR_BODY, "claude");
    expect(result).toEqual({
      ok: true,
      summary: "did the thing",
      prBody: "## What was done\n\nFixed the bug.\n\nCloses #7"
    });
  });

  it("rejects non-string PR body output", () => {
    const result = parseOttoJsonOutput('{"summary":"ok","prBody":123}', "claude");
    expect(result).toEqual({
      ok: false,
      summary: '{"summary":"ok","prBody":123}',
      error: "claude output did not match Otto JSON schema"
    });
  });

  it("strips ```json fences before parsing", () => {
    const fenced = "```json\n" + VALID + "\n```";
    const result = parseOttoJsonOutput(fenced, "claude");
    expect(result).toEqual({ ok: true, summary: "did the thing" });
  });

  it("strips plain ``` fences before parsing", () => {
    const fenced = "```\n" + VALID + "\n```";
    const result = parseOttoJsonOutput(fenced, "claude");
    expect(result).toEqual({ ok: true, summary: "did the thing" });
  });

  it("extracts JSON object embedded in surrounding prose", () => {
    const prose = "Here is my response:\n" + VALID + "\nHope that helps!";
    const result = parseOttoJsonOutput(prose, "claude");
    expect(result).toEqual({ ok: true, summary: "did the thing" });
  });

  it("returns ok: false with empty summary when output is empty", () => {
    const result = parseOttoJsonOutput("", "claude");
    expect(result).toEqual({
      ok: false,
      summary: "",
      error: "claude output was empty; expected Otto JSON"
    });
  });

  it("returns ok: false when output is not parseable JSON", () => {
    const result = parseOttoJsonOutput("not json at all", "claude");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe("claude output was not valid JSON");
  });

  it("returns ok: false when JSON does not match Otto schema", () => {
    const result = parseOttoJsonOutput('{"wrong": "shape"}', "claude");
    expect(result).toEqual({
      ok: false,
      summary: '{"wrong": "shape"}',
      error: "claude output did not match Otto JSON schema"
    });
  });

  it("includes runner name in error messages", () => {
    const result = parseOttoJsonOutput("bad", "codex");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("codex");
  });

  it("truncates fallback summary to 500 chars with ellipsis", () => {
    const long = "x".repeat(600);
    const result = parseOttoJsonOutput(long, "claude");
    expect(result.ok).toBe(false);
    expect(result.summary).toHaveLength(501);
    expect(result.summary.endsWith("…")).toBe(true);
  });
});
