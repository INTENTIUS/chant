import { describe, expect, it } from "bun:test";
import { completions } from "./completions";

describe("LSP completions", () => {
  it("returns an array", () => {
    // TODO: Replace with a real CompletionContext
    const result = completions({} as any);
    expect(Array.isArray(result)).toBe(true);
  });
});
