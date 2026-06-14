/**
 * Security-fate model for the github → forgejo migration edge.
 *
 * github → forgejo YAML is near-identical, so the migration itself is thin. The
 * differentiated value is the **compare**: classifying what survives the move
 * and what Forgejo silently drops. Most properties translate verbatim; the
 * useful findings are the keys the Forgejo runner ignores (`permissions`,
 * `continue-on-error` → `lost`) plus refs/labels that need attention
 * (unresolved `uses:`, unmapped runner labels → `needs-review`).
 *
 * Mirrors the gitlab lexicon's fate model (translated / approximated /
 * needs-review / lost) but for the Forgejo edge — kept local so the forgejo
 * lexicon does not depend on the gitlab one.
 */

import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import { DEFAULT_RUNNER_LABELS } from "../../dialect";
import { resolveActionRef } from "../../actions";

export type SecurityFate = "translated" | "approximated" | "needs-review" | "lost";

export interface SecurityProvenance {
  /** Human label for the property (e.g. "Least-privilege permissions"). */
  property: string;
  /** What happened to the property as it crossed the github → forgejo edge. */
  fate: SecurityFate;
  /** Diagnostic severity for this finding. */
  severity: "error" | "warning" | "info";
  /** How to re-establish the property on Forgejo, when it doesn't carry. */
  reestablish?: string;
}

/** A migration provenance record carrying a security classification. */
export interface SecurityRecord {
  /** YAML-ish path in the source (e.g. "jobs.build.steps[1].uses"). */
  sourceKey: string;
  /** Source file name (for diagnostics). */
  sourceFile?: string;
  /** Functional category (forgejo migration only emits security records). */
  category: "needs-review" | "skipped" | "synthesis";
  /** Rule ID (MIG-FJ-*). */
  rule: string;
  /** Human-readable explanation. */
  note?: string;
  /** Security classification. */
  security: SecurityProvenance;
}

function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Classify the fate of security-relevant properties in a parsed GitHub Actions
 * workflow as it migrates to Forgejo. Walks the source object so occurrence
 * counts (and paths) are precise.
 */
export function analyzeForgejoSecurity(
  workflow: unknown,
  opts: { sourceFile?: string } = {},
): SecurityRecord[] {
  const records: SecurityRecord[] = [];
  const file = opts.sourceFile;

  function visit(value: unknown, path: string): void {
    if (value === null || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }

    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const kebab = toKebabCase(key);
      const childPath = path ? `${path}.${key}` : key;

      if (kebab === "permissions") {
        records.push({
          sourceKey: childPath,
          sourceFile: file,
          category: "skipped",
          rule: "MIG-FJ-PERMISSIONS",
          note: `permissions: is ignored by the Forgejo runner — the least-privilege control is lost. Re-establish it through your Forgejo/runner and repository token settings.`,
          security: { property: "Least-privilege permissions", fate: "lost", severity: "warning", reestablish: "Forgejo runner/token settings" },
        });
        continue; // don't descend into a dropped subtree
      }

      if (kebab === "continue-on-error") {
        records.push({
          sourceKey: childPath,
          sourceFile: file,
          category: "skipped",
          rule: "MIG-FJ-CONTINUE-ON-ERROR",
          note: `continue-on-error is ignored by the Forgejo runner — the failure-tolerance control is lost. A failing step/job will fail the run.`,
          security: { property: "continue-on-error tolerance", fate: "lost", severity: "warning" },
        });
        continue;
      }

      if (kebab === "uses" && typeof v === "string") {
        const { warning } = resolveActionRef(v);
        if (warning) {
          records.push({
            sourceKey: childPath,
            sourceFile: file,
            category: "needs-review",
            rule: "MIG-FJ-ACTION-UNRESOLVED",
            note: `Action ref '${v}' has no built-in Forgejo mapping and won't resolve from a GitHub Marketplace. Use a full repository URL or mirror it under forgejo.actionsRoot.`,
            security: { property: "Action reference", fate: "needs-review", severity: "warning" },
          });
        }
        continue;
      }

      if (kebab === "runs-on") {
        for (const label of runnerLabels(v)) {
          if (DEFAULT_RUNNER_LABELS[label] === undefined) {
            records.push({
              sourceKey: childPath,
              sourceFile: file,
              category: "needs-review",
              rule: "MIG-FJ-RUNNER-LABEL",
              note: `Runner label '${label}' has no built-in Forgejo mapping. Confirm a Forgejo runner advertises it, or map it via forgejo.runnerLabels.`,
              security: { property: "Runner label", fate: "needs-review", severity: "warning" },
            });
          }
        }
        continue;
      }

      visit(v, childPath);
    }
  }

  visit(workflow, "");
  return records;
}

function runnerLabels(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Convert security records into SARIF-shaped diagnostics. Security findings
 * always emit a diagnostic at their severity, escalated to `error` under
 * `--strict` when the property was lost or needs review.
 */
export function provenanceToDiagnostics(
  records: SecurityRecord[],
  opts: { strict?: boolean } = {},
): LintDiagnostic[] {
  return records.map((r) => {
    const escalate = opts.strict && (r.security.fate === "lost" || r.security.fate === "needs-review");
    return {
      file: r.sourceFile ?? "<input>",
      line: 1,
      column: 1,
      ruleId: r.rule,
      severity: escalate ? "error" : r.security.severity,
      message: r.note ?? r.rule,
    };
  });
}

interface PostureLine {
  property: string;
  fate: SecurityFate;
  rule: string;
  count: number;
}

/** Render a "Security posture" Markdown section from the security records. */
export function renderSecurityPosture(records: SecurityRecord[]): string {
  if (records.length === 0) {
    return "## Security posture\n\nNo security-relevant properties weaken or drop at the Forgejo migration edge.\n";
  }

  const byRule = new Map<string, PostureLine>();
  for (const r of records) {
    const existing = byRule.get(r.rule);
    if (existing) existing.count += 1;
    else byRule.set(r.rule, { property: r.security.property, fate: r.security.fate, rule: r.rule, count: 1 });
  }

  let out = "## Security posture\n\n";
  out += "| Property | Fate | Rule | Count |\n|---|---|---|---|\n";
  for (const line of byRule.values()) {
    out += `| ${line.property} | ${line.fate} | ${line.rule} | ${line.count} |\n`;
  }
  out += "\nFates: **translated** (carried as-is) · **approximated** · **needs-review** (confirm/adjust on Forgejo) · **lost** (the Forgejo runner ignores the property).\n";
  return out;
}
