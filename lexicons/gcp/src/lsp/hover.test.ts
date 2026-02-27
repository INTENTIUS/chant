import { describe, test, expect } from "bun:test";
import { gcpHover } from "./hover";

describe("gcpHover", () => {
  test("returns undefined for unknown word", () => {
    const info = gcpHover({
      uri: "file:///a.ts",
      content: "xyz",
      position: { line: 0, character: 1 },
      word: "NotAResource12345",
      lineText: "xyz",
    });
    expect(info).toBeUndefined();
  });
});
