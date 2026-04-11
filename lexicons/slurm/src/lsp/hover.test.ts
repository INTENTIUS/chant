import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("LSP hover", () => {
  it("returns undefined for unknown context", () => {
    // TODO: Replace with a real HoverContext
    const result = hover({} as any);
    expect(result).toBeUndefined();
  });
});
