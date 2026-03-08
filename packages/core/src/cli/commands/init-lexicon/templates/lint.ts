/**
 * Lint template generators for init-lexicon scaffold.
 */

export function generateSampleRuleTs(names: { rulePrefix: string }): string {
  return `import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * ${names.rulePrefix}001: Sample lint rule
 *
 * TODO: Replace with a real lint rule for your lexicon.
 */
export const sampleRule: LintRule = {
  id: "${names.rulePrefix}001",
  severity: "warning",
  category: "style",
  description: "Sample lint rule — replace with real checks",

  check(context: LintContext): LintDiagnostic[] {
    // TODO: Implement rule logic
    return [];
  },
};
`;
}

export function generateLintRulesIndexTs(): string {
  return `export { sampleRule } from "./sample";
`;
}
