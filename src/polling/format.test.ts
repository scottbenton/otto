import { describe, expect, it } from "vitest";

import { buildComment } from "./format.js";

const RUN_ID = "run-uuid";
const MACHINE_ID = "machine-uuid";
const SOURCE_KEY = "issue_comment:1";

describe("buildComment()", () => {
  it("includes the otto:v1 status marker", () => {
    const body = buildComment(RUN_ID, MACHINE_ID, SOURCE_KEY, "Status: running");
    expect(body).toContain("<!-- otto:v1 status");
    expect(body).toContain(`run=${RUN_ID}`);
    expect(body).toContain(`machine=${MACHINE_ID}`);
    expect(body).toContain(`source=${SOURCE_KEY}`);
    expect(body).toContain("-->");
  });

  it("includes the provided content", () => {
    const body = buildComment(RUN_ID, MACHINE_ID, SOURCE_KEY, "Status: running");
    expect(body).toContain("Status: running");
  });

  it("includes the footer link", () => {
    const body = buildComment(RUN_ID, MACHINE_ID, SOURCE_KEY, "Status: running");
    expect(body).toContain("https://github.com/scottbenton/otto");
    expect(body).toContain("🤖 Otto");
  });

  it("places the marker before the content and footer after", () => {
    const body = buildComment(RUN_ID, MACHINE_ID, SOURCE_KEY, "my content");
    const markerEnd = body.indexOf("-->");
    const contentStart = body.indexOf("my content");
    const footerStart = body.indexOf("---");
    expect(markerEnd).toBeLessThan(contentStart);
    expect(contentStart).toBeLessThan(footerStart);
  });

  it("does not include the [Otto] prefix", () => {
    const body = buildComment(RUN_ID, MACHINE_ID, SOURCE_KEY, "Status: running");
    expect(body).not.toContain("[Otto]");
  });
});
