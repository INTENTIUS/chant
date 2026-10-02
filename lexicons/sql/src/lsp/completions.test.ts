import { describe, expect, test } from "vitest";
import { completions } from "./completions";

const ctx = (linePrefix: string, wordAtCursor = "") => ({
  uri: "file:///schema.ts",
  content: linePrefix,
  position: { line: 0, character: linePrefix.length },
  wordAtCursor,
  linePrefix,
});

describe("sql completions", () => {
  test("offer nothing outside a constructor position", () => {
    expect(completions(ctx("const x = 42"))).toEqual([]);
  });

  test("return a list after new", () => {
    expect(Array.isArray(completions(ctx("new ")))).toBe(true);
  });
});
