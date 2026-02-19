import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * FIX001: Sample lint rule
 *
 * TODO: Replace with a real lint rule for your lexicon.
 */
export const sampleRule: LintRule = {
  id: "FIX001",
  severity: "warning",
  category: "style",
  description: "Sample lint rule — replace with real checks",

  check(context: LintContext): LintDiagnostic[] {
    // TODO: Implement rule logic
    return [];
  },
};
