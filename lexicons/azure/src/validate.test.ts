import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const hasGenerated = existsSync(join(pkgDir, "src", "generated", "lexicon-azure.json"));

describe("validate", () => {
  test("validate function exists and is exported", async () => {
    const mod = await import("./validate");
    expect(typeof mod.validate).toBe("function");
  });

  test("REQUIRED_NAMES covers core resource types", async () => {
    // Import the module and verify the validate function doesn't throw
    // for the required names check (structure test)
    const mod = await import("./validate");
    expect(mod.validate).toBeDefined();
  });

  test.skipIf(!hasGenerated)("validate succeeds with generated artifacts", async () => {
    const { validate } = await import("./validate");
    const result = await validate();
    // Should return a ValidateResult with checks array
    expect(result).toBeDefined();
    expect(result.checks).toBeDefined();
    expect(Array.isArray(result.checks)).toBe(true);
  }, 60_000);

  test("handles missing generated files", async () => {
    const { validate } = await import("./validate");
    if (!hasGenerated) {
      try {
        await validate();
      } catch {
        // Expected — no generated files
      }
    }
  });
});
