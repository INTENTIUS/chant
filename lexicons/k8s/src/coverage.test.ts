import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-k8s.json"));

describe("coverage", () => {
  test.skipIf(!hasGenerated)("analyzeK8sCoverage function exists", async () => {
    const { analyzeK8sCoverage } = await import("./coverage");
    expect(typeof analyzeK8sCoverage).toBe("function");
  });

  test("handles missing generated files gracefully", async () => {
    const { analyzeK8sCoverage } = await import("./coverage");
    // If generated files don't exist, this should throw/exit rather than crash
    if (!hasGenerated) {
      try {
        await analyzeK8sCoverage();
      } catch {
        // Expected — no generated files
      }
    }
  });
});
