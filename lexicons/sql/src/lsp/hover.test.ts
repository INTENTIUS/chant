import { describe, expect, test } from "vitest";
import { hover } from "./hover";

const ctx = (word: string) => ({
  uri: "file:///schema.ts",
  content: word,
  position: { line: 0, character: 0 },
  word,
  lineText: word,
});

describe("sql hover", () => {
  test("says nothing about a word that is not an entity class", () => {
    expect(hover(ctx("NotAnEntity"))).toBeUndefined();
  });

  test("says nothing about an empty word", () => {
    expect(hover(ctx(""))).toBeUndefined();
  });
});
