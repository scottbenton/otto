import { describe, expect, it } from "vitest";

import { createGreeting } from "./index.js";

describe("createGreeting", () => {
  it("returns a greeting for a trimmed name", () => {
    expect(createGreeting(" Otto ")).toBe("Hello, Otto. Otto is ready.");
  });

  it("rejects an empty name", () => {
    expect(() => createGreeting("   ")).toThrow("Name is required.");
  });
});
