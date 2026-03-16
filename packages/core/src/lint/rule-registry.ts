/**
 * Rule registry — collects metadata from all rule sources into a flat, sortable array.
 * Used for documentation generation and programmatic rule introspection.
 */

import type { LintRule, Severity, Category } from "./rule";
import type { PostSynthCheck } from "./post-synth";

export interface RuleEntry {
  /** Unique rule ID (e.g. "COR001", "WAW018") */
  id: string;
  /** Human-readable description of what this rule checks */
  description: string;
  /** Rule category */
  category: Category;
  /** Default severity level */
  defaultSeverity: Severity;
  /** Source of the rule ("core" or lexicon name) */
  source: "core" | string;
  /** Phase the rule runs in */
  phase: "pre-synth" | "post-synth";
  /** Whether this rule provides automatic fixes */
  hasAutoFix: boolean;
  /** Link to rule documentation */
  helpUri?: string;
}

/**
 * Build a rule registry from core rules and plugin-provided rules/checks.
 *
 * @param coreRules - Core LintRules (COR/EVL rules from packages/core)
 * @param plugins - Array of plugin contributions with name, rules, and post-synth checks
 * @returns Flat array of RuleEntry sorted by ID
 */
export function buildRuleRegistry(
  coreRules: LintRule[],
  plugins: Array<{
    name: string;
    rules?: LintRule[];
    postSynthChecks?: PostSynthCheck[];
  }> = [],
): RuleEntry[] {
  const entries: RuleEntry[] = [];

  // Core lint rules
  for (const rule of coreRules) {
    entries.push({
      id: rule.id,
      description: rule.description ?? rule.id,
      category: rule.category,
      defaultSeverity: rule.severity,
      source: "core",
      phase: "pre-synth",
      hasAutoFix: typeof rule.fix === "function",
      helpUri: rule.helpUri,
    });
  }

  // Plugin-provided lint rules and post-synth checks
  for (const plugin of plugins) {
    if (plugin.rules) {
      for (const rule of plugin.rules) {
        entries.push({
          id: rule.id,
          description: rule.description ?? rule.id,
          category: rule.category,
          defaultSeverity: rule.severity,
          source: plugin.name,
          phase: "pre-synth",
          hasAutoFix: typeof rule.fix === "function",
          helpUri: rule.helpUri,
        });
      }
    }

    if (plugin.postSynthChecks) {
      for (const check of plugin.postSynthChecks) {
        entries.push({
          id: check.id,
          description: check.description,
          category: inferPostSynthCategory(check.id),
          defaultSeverity: inferPostSynthSeverity(check.id, check.description),
          source: plugin.name,
          phase: "post-synth",
          hasAutoFix: false,
          helpUri: `https://chant.dev/lint-rules/${check.id.toLowerCase()}`,
        });
      }
    }
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Infer category for post-synth checks from rule ID prefix.
 * WAW018+ are security rules, existing WAW/COR/EXT default to correctness.
 */
function inferPostSynthCategory(id: string): Category {
  const num = parseInt(id.replace(/\D/g, ""), 10);
  if (id.startsWith("WAW") && num >= 18) return "security";
  return "correctness";
}

/**
 * Infer default severity for post-synth checks.
 * Security checks with "error" level: WAW018, WAW019, WAW021.
 */
function inferPostSynthSeverity(id: string, description: string): Severity {
  // Check if the description hints at severity
  if (description.toLowerCase().includes("error")) return "error";
  // Known error-level security checks
  const errorIds = new Set(["WAW018", "WAW019", "WAW021"]);
  if (errorIds.has(id)) return "error";
  // Info-level checks
  if (id === "WAW027") return "info";
  return "warning";
}
