/**
 * Convert ProvenanceRecord[] into LintDiagnostic[] for SARIF output.
 *
 * Mapping:
 *   - category "needs-review"   → severity "warning" (or "error" if --strict)
 *   - category "skipped"        → severity "info"
 *   - category "action-map" tier 3 → severity "warning"
 *   - all others                → no diagnostic (clean translation)
 */

import type { LintDiagnostic } from "@intentius/chant/lint/rule";
import type { ProvenanceRecord } from "./provenance";

export interface DiagnosticOptions {
  /** When true, needs-review records become errors instead of warnings */
  strict?: boolean;
}

export function provenanceToDiagnostics(
  records: ProvenanceRecord[],
  opts: DiagnosticOptions = {},
): LintDiagnostic[] {
  const out: LintDiagnostic[] = [];
  for (const r of records) {
    // Security records always emit a diagnostic, at their own severity
    // (escalated to error under --strict when the property was lost or needs
    // review), independent of the functional category.
    if (r.security) {
      const sev =
        opts.strict && (r.security.fate === "lost" || r.security.fate === "needs-review")
          ? "error"
          : r.security.severity;
      out.push({
        file: r.sourceFile ?? "<input>",
        line: r.sourceLine ?? 1,
        column: r.sourceColumn ?? 1,
        ruleId: r.rule,
        severity: sev,
        message: r.note ?? r.rule,
      });
      continue;
    }
    let severity: "error" | "warning" | "info" | undefined;
    if (r.category === "needs-review") {
      severity = opts.strict ? "error" : "warning";
    } else if (r.category === "skipped") {
      severity = "info";
    } else if (r.category === "action-map" && r.mappingTier === 3) {
      severity = "warning";
    } else {
      continue;
    }
    out.push({
      file: r.sourceFile ?? "<input>",
      line: r.sourceLine ?? 1,
      column: r.sourceColumn ?? 1,
      ruleId: r.rule,
      severity,
      message: r.note ?? r.rule,
    });
  }
  return out;
}
