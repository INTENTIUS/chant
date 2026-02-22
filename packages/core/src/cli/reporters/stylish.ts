import type { LintDiagnostic, LintRule, Severity } from "../../lint/rule";
import { pathToFileURL } from "node:url";

/**
 * ANSI color codes
 */
const colors = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
};

/**
 * Check if colors should be used
 */
function useColors(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

/**
 * Apply color if enabled
 */
function color(text: string, colorCode: string): string {
  if (!useColors()) return text;
  return `${colorCode}${text}${colors.reset}`;
}

/**
 * Format diagnostics in stylish format (similar to ESLint)
 * Groups by file, shows severity, message, and rule ID
 */
export function formatStylish(diagnostics: LintDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }

  // Group by file
  const byFile = new Map<string, LintDiagnostic[]>();
  for (const diag of diagnostics) {
    const existing = byFile.get(diag.file) ?? [];
    existing.push(diag);
    byFile.set(diag.file, existing);
  }

  const lines: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const [file, fileDiags] of byFile) {
    // File header with underline
    lines.push("");
    lines.push(color(file, colors.underline));

    // Sort by line, then column
    fileDiags.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    for (const diag of fileDiags) {
      // Count errors and warnings
      if (diag.severity === "error") {
        errorCount++;
      } else if (diag.severity === "warning") {
        warningCount++;
      }

      // Format: "  line:col  severity  message  ruleId"
      const location = color(
        `${String(diag.line).padStart(4)}:${String(diag.column).padEnd(3)}`,
        colors.gray
      );

      const severityColor = diag.severity === "error" ? colors.red : colors.yellow;
      const severity = color(diag.severity.padEnd(7), severityColor);

      const ruleId = color(diag.ruleId, colors.gray);

      lines.push(`  ${location}  ${severity}  ${diag.message}  ${ruleId}`);
    }
  }

  // Summary line
  lines.push("");
  const summary = formatSummary(errorCount, warningCount);
  lines.push(summary);

  return lines.join("\n");
}

/**
 * Format the summary line
 */
export function formatSummary(errorCount: number, warningCount: number): string {
  const parts: string[] = [];

  if (errorCount > 0) {
    parts.push(color(`${errorCount} error${errorCount === 1 ? "" : "s"}`, colors.red));
  }

  if (warningCount > 0) {
    parts.push(color(`${warningCount} warning${warningCount === 1 ? "" : "s"}`, colors.yellow));
  }

  if (parts.length === 0) {
    return color("✓ No problems found", colors.green);
  }

  const symbol = errorCount > 0 ? "✖" : "⚠";
  return `${symbol} ${parts.join(", ")}`;
}

/**
 * Format diagnostics as JSON
 */
export function formatJson(diagnostics: LintDiagnostic[]): string {
  return JSON.stringify(diagnostics, null, 2);
}

/**
 * Map lint severity to SARIF level
 */
function mapSeverity(severity: Severity): "error" | "warning" | "note" {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "note";
}

/**
 * Build a SARIF region object, only including endLine/endColumn when available
 */
function buildRegion(diag: LintDiagnostic): Record<string, number> {
  const region: Record<string, number> = {
    startLine: diag.line,
    startColumn: diag.column,
  };
  if (diag.endLine !== undefined) region.endLine = diag.endLine;
  if (diag.endColumn !== undefined) region.endColumn = diag.endColumn;
  return region;
}

/**
 * Build a SARIF result from a diagnostic
 */
function buildSarifResult(diag: LintDiagnostic, ruleIndex: Map<string, number>) {
  const result: Record<string, unknown> = {
    ruleId: diag.ruleId,
    ruleIndex: ruleIndex.get(diag.ruleId),
    level: mapSeverity(diag.severity),
    message: { text: diag.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: diag.file.startsWith("/") ? pathToFileURL(diag.file).href : diag.file,
          },
          region: buildRegion(diag),
        },
      },
    ],
    fingerprints: {
      "chant/v1": `${diag.ruleId}:${diag.file}:${diag.line}:${diag.column}`,
    },
  };
  return result;
}

/**
 * Format diagnostics as SARIF (Static Analysis Results Interchange Format)
 *
 * @param diagnostics - Active (non-suppressed) diagnostics
 * @param rules - Full list of loaded LintRules for rich metadata (optional)
 * @param suppressed - Suppressed diagnostics with optional reason (optional)
 * @param version - Tool version string (optional, defaults to "0.1.0")
 */
export function formatSarif(
  diagnostics: LintDiagnostic[],
  rules?: LintRule[],
  suppressed?: Array<LintDiagnostic & { reason?: string }>,
  version?: string,
): string {
  // Build rule metadata from LintRule objects when available, otherwise from diagnostics
  const { sarifRules, ruleIndex } = buildRuleMetadata(diagnostics, suppressed ?? [], rules);

  // Build active results
  const results: Record<string, unknown>[] = diagnostics.map((diag) =>
    buildSarifResult(diag, ruleIndex),
  );

  // Append suppressed results with SARIF suppressions
  if (suppressed) {
    for (const diag of suppressed) {
      const result = buildSarifResult(diag, ruleIndex);
      result.suppressions = [
        {
          kind: "inSource",
          ...(diag.reason ? { justification: diag.reason } : {}),
        },
      ];
      results.push(result);
    }
  }

  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "chant",
            version: version ?? "0.1.0",
            informationUri: "https://chant.dev",
            rules: sarifRules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Build SARIF rule metadata from loaded LintRules and/or diagnostics.
 * Returns both the rules array and a ruleId→index map for result references.
 */
function buildRuleMetadata(
  diagnostics: LintDiagnostic[],
  suppressed: LintDiagnostic[],
  rules?: LintRule[],
): {
  sarifRules: Record<string, unknown>[];
  ruleIndex: Map<string, number>;
} {
  // Build a lookup from rule objects
  const ruleMap = new Map<string, LintRule>();
  if (rules) {
    for (const r of rules) {
      ruleMap.set(r.id, r);
    }
  }

  // Collect all unique rule IDs from diagnostics + suppressed
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const diag of [...diagnostics, ...suppressed]) {
    if (!seen.has(diag.ruleId)) {
      seen.add(diag.ruleId);
      orderedIds.push(diag.ruleId);
    }
  }

  const sarifRules: Record<string, unknown>[] = [];
  const ruleIndex = new Map<string, number>();

  for (const id of orderedIds) {
    const rule = ruleMap.get(id);
    const descText = rule?.description || id;
    const entry: Record<string, unknown> = {
      id,
      shortDescription: { text: descText },
      fullDescription: { text: descText },
      helpUri: rule?.helpUri || `https://chant.dev/lint-rules/${id.toLowerCase()}`,
      defaultConfiguration: {
        level: mapSeverity(rule?.severity ?? "warning"),
      },
    };
    if (rule?.category) {
      entry.properties = { category: rule.category };
    }
    ruleIndex.set(id, sarifRules.length);
    sarifRules.push(entry);
  }

  return { sarifRules, ruleIndex };
}
