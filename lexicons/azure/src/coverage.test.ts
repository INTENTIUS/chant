import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-azure.json"));

describe("coverage", () => {
  test("computeCoverage function is exported", async () => {
    const { computeCoverage } = await import("./coverage");
    expect(typeof computeCoverage).toBe("function");
  });

  test("overallPct function is exported", async () => {
    const { overallPct } = await import("./coverage");
    expect(typeof overallPct).toBe("function");
  });

  test("formatSummary function is exported", async () => {
    const { formatSummary } = await import("./coverage");
    expect(typeof formatSummary).toBe("function");
  });

  test("checkThresholds function is exported", async () => {
    const { checkThresholds } = await import("./coverage");
    expect(typeof checkThresholds).toBe("function");
  });

  test("handles missing generated files gracefully", async () => {
    const { computeCoverage } = await import("./coverage");
    if (!hasGenerated) {
      try {
        await computeCoverage();
      } catch {
        // Expected — no generated files
      }
    }
  });
});
