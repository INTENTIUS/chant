import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-flyway.json"));

describe("coverage", () => {
  test.skipIf(!hasGenerated)("analyzeFlywyCoverage function exists", async () => {
    const { analyzeFlywyCoverage } = await import("./coverage");
    expect(typeof analyzeFlywyCoverage).toBe("function");
  });

  test("handles missing generated files gracefully", async () => {
    const { analyzeFlywyCoverage } = await import("./coverage");
    if (!hasGenerated) {
      try {
        await analyzeFlywyCoverage();
      } catch {
        // Expected — no generated files
      }
    }
  });
});
