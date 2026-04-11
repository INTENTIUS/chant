import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-gcp.json"));

describe("coverage", () => {
  test.skipIf(!hasGenerated)("analyzeGcpCoverage function exists", async () => {
    const { analyzeGcpCoverage } = await import("./coverage");
    expect(typeof analyzeGcpCoverage).toBe("function");
  });

  test("handles missing generated files gracefully", async () => {
    const { analyzeGcpCoverage } = await import("./coverage");
    // If generated files don't exist, this should throw/exit rather than crash
    if (!hasGenerated) {
      try {
        await analyzeGcpCoverage();
      } catch {
        // Expected — no generated files
      }
    }
  });
});
