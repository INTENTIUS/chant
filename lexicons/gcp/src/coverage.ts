/**
 * GCP lexicon coverage analysis.
 */

import {
  computeCoverage,
  overallPct,
  formatSummary,
  formatVerbose,
  checkThresholds,
  type CoverageReport,
} from "@intentius/chant/codegen/coverage";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export {
  computeCoverage,
  overallPct,
  formatSummary,
  formatVerbose,
  checkThresholds,
  type ResourceCoverage,
  type CoverageReport,
  type CoverageThresholds,
  type ThresholdResult,
} from "@intentius/chant/codegen/coverage";

export async function analyzeGcpCoverage(opts?: {
  verbose?: boolean;
  minOverall?: number;
}): Promise<void> {
  const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const lexiconPath = join(pkgDir, "src", "generated", "lexicon-gcp.json");
  const content = readFileSync(lexiconPath, "utf-8");
  const report = computeCoverage(content);

  if (opts?.verbose) {
    console.log(formatVerbose(report));
  } else {
    console.log(formatSummary(report));
  }

  if (typeof opts?.minOverall === "number") {
    const result = checkThresholds(report, { minOverallPct: opts.minOverall });
    if (!result.ok) {
      for (const v of result.violations) console.error(`  FAIL: ${v}`);
      throw new Error("Coverage below threshold");
    }
  }
}
