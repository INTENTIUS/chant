import { describe, test, expect } from "bun:test";
import { computeCoverage, overallPct, formatSummary } from "./coverage";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconJSON = readFileSync(join(basePath, "src", "generated", "lexicon-gitlab.json"), "utf-8");

describe("coverage analysis", () => {
  test("computes coverage for GitLab lexicon", () => {
    const report = computeCoverage(lexiconJSON);
    expect(report.resourceCount).toBe(3); // Job, Default, Workflow
    expect(report.resources).toHaveLength(3);
  });

  test("reports resource names correctly", () => {
    const report = computeCoverage(lexiconJSON);
    const names = report.resources.map((r) => r.name);
    expect(names).toContain("Job");
    expect(names).toContain("Default");
    expect(names).toContain("Workflow");
  });

  test("overallPct returns a number", () => {
    const report = computeCoverage(lexiconJSON);
    const pct = overallPct(report);
    expect(typeof pct).toBe("number");
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test("formatSummary returns readable string", () => {
    const report = computeCoverage(lexiconJSON);
    const summary = formatSummary(report);
    expect(summary).toContain("Coverage Report");
    expect(summary).toContain("3 resources");
  });
});
