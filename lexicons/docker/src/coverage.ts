/**
 * Coverage analysis for Docker lexicon.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  computeCoverage,
  overallPct,
  formatSummary,
  formatVerbose,
  checkThresholds,
  type CoverageReport,
  type CoverageThresholds,
} from "@intentius/chant/codegen/coverage";

export type { CoverageReport, CoverageThresholds };
export { computeCoverage, overallPct, formatSummary, formatVerbose, checkThresholds };

/**
 * Run coverage analysis for the Docker lexicon.
 */
export async function analyzeDockerCoverage(opts?: {
  basePath?: string;
  verbose?: boolean;
  minOverall?: number;
}): Promise<CoverageReport> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const lexiconPath = join(basePath, "src", "generated", "lexicon-docker.json");

  if (!existsSync(lexiconPath)) {
    throw new Error(`Generated lexicon not found at ${lexiconPath}. Run "chant dev generate" first.`);
  }

  const content = readFileSync(lexiconPath, "utf-8");
  const report = computeCoverage(content);

  if (opts?.verbose) {
    console.error(formatVerbose(report));
  } else {
    console.error(formatSummary(report));
  }

  if (typeof opts?.minOverall === "number") {
    const result = checkThresholds(report, { minOverallPct: opts.minOverall });
    if (!result.ok) {
      for (const v of result.violations) console.error(`  FAIL: ${v}`);
      throw new Error("Coverage below threshold");
    }
  }

  return report;
}
