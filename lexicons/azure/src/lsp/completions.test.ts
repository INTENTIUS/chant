import { describe, test, expect } from "vitest";

/**
 * LSP completions tests.
 *
 * These tests verify the completions provider structure.
 * Full integration tests require generated lexicon data.
 */
describe("Azure LSP Completions", () => {
  test("azureCompletions is exported as a function", async () => {
    const mod = await import("./completions");
    expect(typeof mod.azureCompletions).toBe("function");
  });
});
