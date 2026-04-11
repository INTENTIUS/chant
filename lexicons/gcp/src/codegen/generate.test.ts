import { describe, test, expect } from "vitest";
import { generate } from "./generate";

describe("generate", () => {
  test("generate function exists and is callable", () => {
    expect(typeof generate).toBe("function");
  });

  test("generate returns a promise", { timeout: 15000 }, () => {
    // Call with no-op options to verify it returns a promise-like object.
    // We don't await because it may require network/file access.
    const result = generate({ dryRun: true });
    expect(result).toBeDefined();
    expect(typeof result.then).toBe("function");
    // Suppress unhandled rejection if it fails due to missing spec
    result.catch(() => {});
  });
});
