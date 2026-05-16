import { describe, expect, it } from "vitest";

import { Daemon } from "./index.js";

describe("index exports", () => {
  it("exports Daemon", () => {
    expect(Daemon).toBeDefined();
  });
});
