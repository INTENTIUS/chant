/**
 * Coverage analysis for the Temporal lexicon.
 *
 * All 4 resources are hand-written (no remote spec), so coverage is always
 * 100% by definition. This module satisfies the lexicon completeness checklist
 * and provides a consistent interface for the plugin's coverage() lifecycle method.
 */

export interface CoverageResult {
  total: number;
  covered: number;
  missing: string[];
}

const RESOURCES = [
  "Temporal::Server",
  "Temporal::Namespace",
  "Temporal::SearchAttribute",
  "Temporal::Schedule",
] as const;

export function analyze(): CoverageResult {
  return {
    total: RESOURCES.length,
    covered: RESOURCES.length,
    missing: [],
  };
}

export function printCoverageResult(result: CoverageResult, verbose?: boolean): void {
  if (verbose) {
    console.error(
      `Coverage: ${result.covered}/${result.total} resources (${Math.round((result.covered / result.total) * 100)}%).`,
    );
    console.error("All resources are hand-written — no remote spec to track against.");
  }
}
