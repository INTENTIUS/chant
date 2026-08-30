import { describe, expect, it } from "vitest";
import { completions } from "./completions";

describe("render LSP completions", () => {
  it("returns nothing for a non-constructor context", () => {
    const items = completions({
      uri: "file:///a.ts",
      content: "const x = 42",
      position: { line: 0, character: 12 },
      wordAtCursor: "42",
      linePrefix: "const x = 42",
    });
    expect(items).toHaveLength(0);
  });

  it("completes resource classes after `new`", () => {
    const items = completions({
      uri: "file:///infra.ts",
      content: "const web = new Web",
      position: { line: 0, character: 19 },
      wordAtCursor: "Web",
      linePrefix: "const web = new Web",
    });
    const labels = items.map((c) => c.label);
    expect(labels).toContain("WebService");
    expect(labels).toContain("Webhook");
  });
});
