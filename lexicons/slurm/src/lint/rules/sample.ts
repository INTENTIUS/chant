import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * SLU001: Sample lint rule
 *
 * TODO: Replace with a real lint rule for your lexicon.
 */
export const sampleRule: LintRule = {
  id: "SLU001",
  severity: "warning",
  category: "style",
  description: "Sample lint rule — replace with real checks",

  check(context: LintContext): LintDiagnostic[] {
    // TODO: Implement rule logic
    return [];
  },
};
