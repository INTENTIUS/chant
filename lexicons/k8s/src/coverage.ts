/**
 * Coverage analysis for the Kubernetes lexicon.
 *
 * Analyzes generated resources for coverage of property constraints,
 * lifecycle attributes, and other dimensions.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeCoverage, overallPct, type CoverageReport } from "@intentius/chant/codegen/coverage";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Analyze coverage of the K8s lexicon.
 */
export async function analyzeK8sCoverage(opts?: {
  verbose?: boolean;
  minOverall?: number;
}): Promise<void> {
  const generatedDir = join(pkgDir, "src", "generated");
  const lexiconJSON = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
  const report = computeCoverage(lexiconJSON);

  const pct = overallPct(report);
  console.error(`K8s lexicon coverage: ${pct.toFixed(1)}%`);
  console.error(`  Resources: ${report.resourceCount}`);
  console.error(`  Property constraints: ${report.propertyPct.toFixed(1)}%`);

  if (opts?.minOverall && pct < opts.minOverall) {
    console.error(`Coverage ${pct.toFixed(1)}% is below minimum ${opts.minOverall}%`);
    process.exit(1);
  }
}
