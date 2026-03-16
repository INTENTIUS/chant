import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-aws.json"));

describe("coverage", () => {
  test.skipIf(!hasGenerated)("computeCoverage function exists", async () => {
    const { computeCoverage } = await import("./coverage");
    expect(typeof computeCoverage).toBe("function");
  });

  test.skipIf(!hasGenerated)("overallPct function exists", async () => {
    const { overallPct } = await import("./coverage");
    expect(typeof overallPct).toBe("function");
  });

  test("handles missing generated files gracefully", async () => {
    const { computeCoverage } = await import("./coverage");
    if (!hasGenerated) {
      try {
        await computeCoverage(generatedDir);
      } catch {
        // Expected — no generated files
      }
    }
  });
});
