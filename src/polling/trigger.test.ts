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
  it("returns null when body does not start with the keyword", () => {
    expect(detectTrigger(makeComment("please do something"), REPO, KEYWORD)).toBeNull();
  });

  it("returns null when keyword appears mid-word (no word boundary)", () => {
    expect(detectTrigger(makeComment("ottomation is great"), REPO, KEYWORD)).toBeNull();
  });

  it("returns null when keyword appears later in the body", () => {
    expect(detectTrigger(makeComment("hey otto do this"), REPO, KEYWORD)).toBeNull();
  });

  it("matches a bare keyword with empty taskDescription", () => {
    const comment = makeComment("otto");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match).not.toBeNull();
    expect(match?.taskDescription).toBe("");
  });

  it("matches keyword followed by a task description", () => {
    const comment = makeComment("otto fix the tests");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match?.taskDescription).toBe("fix the tests");
  });

  it("is case-insensitive for the keyword", () => {
    expect(detectTrigger(makeComment("OTTO do this"), REPO, KEYWORD)).not.toBeNull();
    expect(detectTrigger(makeComment("Otto do this"), REPO, KEYWORD)).not.toBeNull();
  });

  it("trims leading and trailing whitespace from the body before matching", () => {
    const match = detectTrigger(makeComment("  otto fix tests  "), REPO, KEYWORD);
    expect(match).not.toBeNull();
    expect(match?.taskDescription).toBe("fix tests");
  });

  it("trims leading whitespace from taskDescription", () => {
    const match = detectTrigger(makeComment("otto   lots of spaces"), REPO, KEYWORD);
    expect(match?.taskDescription).toBe("lots of spaces");
  });

  it("includes the original comment in the match", () => {
    const comment = makeComment("otto do it");
    const match = detectTrigger(comment, REPO, KEYWORD);
    expect(match?.comment).toBe(comment);
  });

  it("includes the repo in the match", () => {
    const match = detectTrigger(makeComment("otto do it"), "my-org/my-repo", KEYWORD);
    expect(match?.repo).toBe("my-org/my-repo");
  });

  it("works with a custom keyword", () => {
    expect(detectTrigger(makeComment("bot run tests"), REPO, "bot")).not.toBeNull();
    expect(detectTrigger(makeComment("otto run tests"), REPO, "bot")).toBeNull();
  });
});
