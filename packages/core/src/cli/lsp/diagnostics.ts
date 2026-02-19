import type { LintDiagnostic, Severity } from "../../lint/rule";

/**
 * LSP diagnostic as returned in textDocument/publishDiagnostics.
 */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  code?: string;
  source: string;
  message: string;
  data?: { ruleId: string; fix?: unknown };
}

/**
 * Map chant severity to LSP DiagnosticSeverity (1=Error, 2=Warning, 3=Info, 4=Hint)
 */
function toLspSeverity(severity: Severity): number {
  switch (severity) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "info":
      return 3;
  }
}

/**
 * Convert chant LintDiagnostics to LSP diagnostics.
 * Converts 1-based lines/columns to 0-based.
 */
export function toLspDiagnostics(diagnostics: LintDiagnostic[]): LspDiagnostic[] {
  return diagnostics.map((d) => {
    const line = Math.max(0, d.line - 1);
    const character = Math.max(0, d.column - 1);
    return {
      range: {
        start: { line, character },
        end: { line, character },
      },
      severity: toLspSeverity(d.severity),
      code: d.ruleId,
      source: "chant",
      message: d.message,
      data: d.fix ? { ruleId: d.ruleId, fix: d.fix } : { ruleId: d.ruleId },
    };
  });
}
