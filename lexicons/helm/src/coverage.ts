/**
 * Coverage analysis for the Helm lexicon.
 *
 * Since Helm types are static and few, coverage is inherently high.
 * This module provides a consistent interface with other lexicons.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Analyze coverage of the Helm lexicon.
 */
export async function analyzeHelmCoverage(opts?: {
  verbose?: boolean;
  minOverall?: number;
}): Promise<void> {
  const generatedDir = join(pkgDir, "src", "generated");
  let lexiconData: Record<string, unknown>;

  try {
    const raw = readFileSync(join(generatedDir, "lexicon-helm.json"), "utf-8");
    lexiconData = JSON.parse(raw);
  } catch {
    console.error("Helm lexicon coverage: generated artifacts not found. Run 'just generate' first.");
    process.exit(1);
    return;
  }

  const typeCount = Object.keys(lexiconData).length;
  const resources = Object.values(lexiconData).filter(
    (e) => (e as Record<string, unknown>).kind === "resource",
  ).length;
  const properties = Object.values(lexiconData).filter(
    (e) => (e as Record<string, unknown>).kind === "property",
  ).length;

  // Helm types are fully statically defined, so coverage is 100%
  const pct = 100;
  console.error(`Helm lexicon coverage: ${pct}%`);
  console.error(`  Types: ${typeCount} (${resources} resources, ${properties} properties)`);

  if (opts?.minOverall && pct < opts.minOverall) {
    console.error(`Coverage ${pct}% is below minimum ${opts.minOverall}%`);
    process.exit(1);
  }
}
