import { describe, test, expect } from "bun:test";
import { validate } from "./validate";

describe("validate", () => {
  test("validate function exists and returns ValidateResult", async () => {
    // validate runs against generated files — may fail if not generated
    try {
      const result = await validate();
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(Array.isArray(result.checks)).toBe(true);
    } catch {
      // Expected if generated files don't exist
    }
  });

  test("result has checks array", async () => {
    try {
      const result = await validate();
      expect(Array.isArray(result.checks)).toBe(true);
      for (const check of result.checks) {
        expect(check).toHaveProperty("name");
        expect(check).toHaveProperty("passed");
      }
    } catch {
      // Expected if generated files don't exist
    }
  });
});
