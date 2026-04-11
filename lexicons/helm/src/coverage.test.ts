import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-helm.json"));

describe("coverage", () => {
  test.skipIf(!hasGenerated)("analyzeHelmCoverage function exists", async () => {
    const { analyzeHelmCoverage } = await import("./coverage");
    expect(typeof analyzeHelmCoverage).toBe("function");
  });

  test.skipIf(!hasGenerated)("runs coverage analysis", async () => {
    const { analyzeHelmCoverage } = await import("./coverage");
    // Should complete without throwing
    await analyzeHelmCoverage();
  });
});
