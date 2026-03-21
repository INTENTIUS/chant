import { describe, expect, it } from "bun:test";
import { hover } from "./hover";

describe("LSP hover", () => {
  it("returns undefined for unknown context", () => {
    // TODO: Replace with a real HoverContext
    const result = hover({} as any);
    expect(result).toBeUndefined();
  });
});
