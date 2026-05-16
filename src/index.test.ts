import { describe, expect, it } from "vitest";

import { createDaemon } from "./index.js";

describe("index exports", () => {
  it("exports createDaemon", () => {
    expect(createDaemon).toBeDefined();
  });
});
