import { describe, test, expect } from "bun:test";
import { gcpCompletions } from "./completions";

describe("gcpCompletions", () => {
  test("returns empty for non-constructor context", () => {
    const items = gcpCompletions({
      uri: "file:///a.ts",
      content: "const x = 42",
      position: { line: 0, character: 13 },
      wordAtCursor: "42",
      linePrefix: "const x = 42",
    });
    expect(items).toHaveLength(0);
  });
});
