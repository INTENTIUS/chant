import { describe, test, expect } from "vitest";

/**
 * LSP hover tests.
 *
 * These tests verify the hover provider structure.
 * Full integration tests require generated lexicon data.
 */
describe("Azure LSP Hover", () => {
  test("azureHover is exported as a function", async () => {
    const mod = await import("./hover");
    expect(typeof mod.azureHover).toBe("function");
  });
});
