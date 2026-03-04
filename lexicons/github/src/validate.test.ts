import { describe, test, expect } from "bun:test";
import { validate } from "./validate";

describe("validate", () => {
  test("exports validate function", () => {
    expect(typeof validate).toBe("function");
  });

  // Note: Full validation requires generated artifacts to exist.
  // This test verifies the validate module loads correctly.
  // Run `bun run generate` first for full validation tests.
});
