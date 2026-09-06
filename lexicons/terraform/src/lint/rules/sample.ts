import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * TF901: the scaffold placeholder.
 *
 * Kept only so `lintRules()` returns something while the real source-level
 * rules are written (#2085 owns TF101 and the rest). Numbered in the 900s to
 * stay out of their way, and to be deleted the moment one of them lands.
 */
export const sampleRule: LintRule = {
  id: "TF901",
  severity: "warning",
  category: "style",
  description: "Scaffold placeholder, replaced by the real source-level rules in #2085",

  check(_context: LintContext): LintDiagnostic[] {
    return [];
  },
};
