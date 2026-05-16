import { describe, expect, it } from "vitest";

import { classifyTask } from "./classify.js";

describe("classifyTask() — ignore (reserved keywords)", () => {
  it.each(["retry", "cancel", "stop", "done", "thanks", "ok"])(
    "returns ignore for reserved keyword '%s'",
    (word) => {
      expect(classifyTask(word, "issue_comment").type).toBe("ignore");
    },
  );

  it("is case-insensitive for reserved keywords", () => {
    expect(classifyTask("CANCEL", "issue_comment").type).toBe("ignore");
    expect(classifyTask("Retry", "issue_comment").type).toBe("ignore");
  });

  it("does not treat a reserved keyword embedded in a longer phrase as ignore", () => {
    expect(classifyTask("cancel the thing and fix it", "issue_comment").type).not.toBe("ignore");
  });
});

describe("classifyTask() — clarify (empty / ambiguous)", () => {
  it("returns clarify for an empty description", () => {
    expect(classifyTask("", "issue_comment").type).toBe("clarify");
  });

  it("returns clarify for whitespace-only description", () => {
    expect(classifyTask("   ", "issue_comment").type).toBe("clarify");
  });

  it("returns clarify when no question or action words are detected", () => {
    expect(classifyTask("the auth thing", "issue_comment").type).toBe("clarify");
    expect(classifyTask("login page", "pr_conversation_comment").type).toBe("clarify");
  });
});

describe("classifyTask() — answer (question words, no action verbs)", () => {
  it.each([
    "why does this fail",
    "what is the auth flow",
    "how does pagination work",
    "explain the retry logic",
    "where is the config loaded",
    "when does the token expire",
    "which branch should I use",
  ])("returns answer for '%s'", (desc) => {
    expect(classifyTask(desc, "issue_comment").type).toBe("answer");
  });

  it("is case-insensitive for question words", () => {
    expect(classifyTask("WHY does this break", "issue_comment").type).toBe("answer");
  });

  it("returns answer even on PR source when no action verb is present", () => {
    expect(classifyTask("why was this changed", "pr_line_comment").type).toBe("answer");
  });
});

describe("classifyTask() — modify_existing_pr (action verbs on PR sources)", () => {
  it.each(["pr_line_comment", "pr_conversation_comment"] as const)(
    "returns modify_existing_pr for action verb on %s",
    (sourceType) => {
      expect(classifyTask("fix the null check", sourceType).type).toBe("modify_existing_pr");
    },
  );

  it.each([
    "fix the bug",
    "change the timeout",
    "update the schema",
    "add a test",
    "remove the dead code",
    "refactor the auth module",
    "revert the last commit",
    "implement the retry logic",
    "create a helper",
    "write a test",
    "make it work",
    "move the file",
    "rename the function",
    "replace the library",
    "extract the utility",
    "clean up the code",
    "improve the error message",
    "optimize the query",
  ])("detects action verb in '%s' → modify_existing_pr on pr_line_comment", (desc) => {
    expect(classifyTask(desc, "pr_line_comment").type).toBe("modify_existing_pr");
  });

  it("prefers modify_existing_pr over answer when both question and action words appear on PR", () => {
    // Action wins over question when both present
    expect(classifyTask("why doesn't this fix work", "pr_line_comment").type).toBe("modify_existing_pr");
  });
});

describe("classifyTask() — implement_issue (action verbs on issue source)", () => {
  it("returns implement_issue for action verb on issue_comment", () => {
    expect(classifyTask("fix the login bug", "issue_comment").type).toBe("implement_issue");
    expect(classifyTask("add pagination to the user list", "issue_comment").type).toBe("implement_issue");
    expect(classifyTask("implement the retry mechanism", "issue_comment").type).toBe("implement_issue");
  });

  it("prefers implement_issue over answer when both question and action words appear on issue", () => {
    expect(classifyTask("why not just fix it", "issue_comment").type).toBe("implement_issue");
  });
});

describe("classifyTask() — source type routing", () => {
  it("routes the same action phrase differently based on source type", () => {
    expect(classifyTask("fix the bug", "issue_comment").type).toBe("implement_issue");
    expect(classifyTask("fix the bug", "pr_conversation_comment").type).toBe("modify_existing_pr");
    expect(classifyTask("fix the bug", "pr_line_comment").type).toBe("modify_existing_pr");
  });
});
