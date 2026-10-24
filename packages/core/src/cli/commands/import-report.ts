/**
 * The review report of `chant import` (#4398): the parser's diagnostics as
 * SARIF (`--report <path>`), a summary on stderr, and the exit code under
 * `--strict`. The shape follows `chant migrate`: a needs-review diagnostic is
 * a `warning`, and `--strict` makes any open `warning` or `error` fail the
 * run. An `info` diagnostic names something not carried that needs no
 * decision, and never fails a run.
 */

import { writeFileSync } from "fs";
import type { ImportDiagnostic } from "../../import/parser";
import type { LintDiagnostic } from "../../lint/rule";
import { formatSarif } from "../reporters/stylish";

/** Import diagnostics as lint diagnostics against `file`, the template that was imported. */
export function importDiagnosticsToLint(file: string, diagnostics: readonly ImportDiagnostic[]): LintDiagnostic[] {
  return diagnostics.map((d) => ({
    file,
    line: d.line ?? 1,
    column: d.column ?? 1,
    ruleId: d.ruleId,
    severity: d.severity,
    message: d.message,
    ...(d.entity ? { entity: d.entity } : {}),
  }));
}

/** The SARIF document for a run. */
export function importSarif(file: string, diagnostics: readonly ImportDiagnostic[], version?: string): string {
  return formatSarif(importDiagnosticsToLint(file, diagnostics), undefined, undefined, version);
}

/** Write the SARIF report; an unwritable path is returned as a message, not thrown. */
export function writeImportReport(path: string, file: string, diagnostics: readonly ImportDiagnostic[], version?: string): string | undefined {
  try {
    writeFileSync(path, importSarif(file, diagnostics, version));
    return undefined;
  } catch (err) {
    return `could not write SARIF report to ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Diagnostics that are open: everything but `info`. */
export function openDiagnostics(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] {
  return diagnostics.filter((d) => d.severity !== "info");
}

/**
 * The exit code for a finished import. An `error` always fails (a failed
 * `--validate`); a `warning` fails under `--strict`.
 */
export function importExitCode(diagnostics: readonly ImportDiagnostic[] | undefined, strict: boolean): number {
  if (!diagnostics) return 0;
  if (diagnostics.some((d) => d.severity === "error")) return 1;
  return strict && diagnostics.some((d) => d.severity === "warning") ? 1 : 0;
}

/** Counts by severity and rule, as the lines printed after an import. */
export function summarizeImportDiagnostics(diagnostics: readonly ImportDiagnostic[]): string {
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byRule = new Map<string, number>();
  for (const d of diagnostics) {
    bySeverity[d.severity]++;
    byRule.set(d.ruleId, (byRule.get(d.ruleId) ?? 0) + 1);
  }
  const rules = [...byRule].sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${id} x${String(n)}`);
  return [
    `Review: ${String(bySeverity.warning)} to review, ${String(bySeverity.error)} errors, ${String(bySeverity.info)} notes (${rules.join(", ")}).`,
    "Write them with --report <path> as SARIF; --strict fails while any to review or error is open.",
  ].join("\n");
}
