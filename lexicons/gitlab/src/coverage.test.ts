import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconPath = join(basePath, "src", "generated", "lexicon-gitlab.json");
const hasGenerated = existsSync(lexiconPath);

describe("coverage analysis", () => {
  test.skipIf(!hasGenerated)("computes coverage for GitLab lexicon", async () => {
    const { computeCoverage } = await import("./coverage");
    const lexiconJSON = readFileSync(lexiconPath, "utf-8");
    const report = computeCoverage(lexiconJSON);
    expect(report.resourceCount).toBe(3); // Job, Default, Workflow
    expect(report.resources).toHaveLength(3);
  });

  test.skipIf(!hasGenerated)("reports resource names correctly", async () => {
    const { computeCoverage } = await import("./coverage");
    const lexiconJSON = readFileSync(lexiconPath, "utf-8");
    const report = computeCoverage(lexiconJSON);
    const names = report.resources.map((r) => r.name);
    expect(names).toContain("Job");
    expect(names).toContain("Default");
    expect(names).toContain("Workflow");
  });

  test.skipIf(!hasGenerated)("overallPct returns a number", async () => {
    const { computeCoverage, overallPct } = await import("./coverage");
    const lexiconJSON = readFileSync(lexiconPath, "utf-8");
    const report = computeCoverage(lexiconJSON);
    const pct = overallPct(report);
    expect(typeof pct).toBe("number");
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test.skipIf(!hasGenerated)("formatSummary returns readable string", async () => {
    const { computeCoverage, formatSummary } = await import("./coverage");
    const lexiconJSON = readFileSync(lexiconPath, "utf-8");
    const report = computeCoverage(lexiconJSON);
    const summary = formatSummary(report);
    expect(summary).toContain("Coverage Report");
    expect(summary).toContain("3 resources");
  });
});
