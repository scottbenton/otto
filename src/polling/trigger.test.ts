import { describe, expect, it } from "vitest";

import type { RawComment } from "./types.js";
import { detectTrigger } from "./trigger.js";

function makeComment(body: string): RawComment {
  return {
    id: 1,
    body,
    user: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: "https://github.com/owner/repo/issues/1#issuecomment-1",
    issue_url: "https://api.github.com/repos/owner/repo/issues/1",
  };
}

const REPO = "owner/repo";
const KEYWORD = "otto";

describe("detectTrigger()", () => {
  it("returns null when body does not contain the keyword", () => {
    expect(detectTrigger(makeComment("please do something"), REPO, KEYWORD)).toBeNull();
  });

  it("returns null when keyword appears mid-word (no word boundary)", () => {
    expect(detectTrigger(makeComment("ottomation is great"), REPO, KEYWORD)).toBeNull();
  });

  it("matches keyword at the start of the body", () => {
    expect(detectTrigger(makeComment("otto fix the tests"), REPO, KEYWORD)).not.toBeNull();
  });

  it("matches keyword in the middle of the body", () => {
    expect(detectTrigger(makeComment("hey otto, can we fix this?"), REPO, KEYWORD)).not.toBeNull();
  });

  it("matches keyword at the end of the body", () => {
    expect(detectTrigger(makeComment("tagging otto"), REPO, KEYWORD)).not.toBeNull();
  });

  it("uses the full trimmed body as taskDescription", () => {
    const comment = makeComment("  hey otto, can we fix the tests?  ");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match?.taskDescription).toBe("hey otto, can we fix the tests?");
  });

  it("is case-insensitive for the keyword", () => {
    expect(detectTrigger(makeComment("Hey OTTO, do this"), REPO, KEYWORD)).not.toBeNull();
    expect(detectTrigger(makeComment("Hey Otto, do this"), REPO, KEYWORD)).not.toBeNull();
  });

  it("matches a bare keyword with the keyword as taskDescription", () => {
    const comment = makeComment("otto");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match).not.toBeNull();
    expect(match?.taskDescription).toBe("otto");
  });

  it("includes the original comment in the match", () => {
    const comment = makeComment("hey otto do it");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match?.comment).toBe(comment);
  });

  it("includes the repo in the match", () => {
    const match = detectTrigger(makeComment("otto do it"), "my-org/my-repo", KEYWORD);
    expect(match?.repo).toBe("my-org/my-repo");
  });

  it("works with a custom keyword", () => {
    expect(detectTrigger(makeComment("hey bot, run tests"), REPO, "bot")).not.toBeNull();
    expect(detectTrigger(makeComment("hey otto, run tests"), REPO, "bot")).toBeNull();
  });

  it("keyword adjacent to punctuation still matches", () => {
    expect(detectTrigger(makeComment("otto, please fix this"), REPO, KEYWORD)).not.toBeNull();
    expect(detectTrigger(makeComment("hey @otto fix this"), REPO, KEYWORD)).not.toBeNull();
  });
});
