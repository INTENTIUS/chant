import type { LintDiagnostic } from "../../lint/rule";

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
 * Format diagnostics as SARIF (Static Analysis Results Interchange Format)
 */
export function formatSarif(diagnostics: LintDiagnostic[]): string {
  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "chant",
            version: "0.1.0",
            informationUri: "https://chant.dev",
            rules: getUniqueRules(diagnostics),
          },
        },
        results: diagnostics.map((diag) => ({
          ruleId: diag.ruleId,
          level: diag.severity === "error" ? "error" : diag.severity === "warning" ? "warning" : "note",
          message: {
            text: diag.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: diag.file,
                },
                region: {
                  startLine: diag.line,
                  startColumn: diag.column,
                },
              },
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Extract unique rules from diagnostics for SARIF
 */
function getUniqueRules(diagnostics: LintDiagnostic[]): Array<{ id: string; shortDescription: { text: string } }> {
  const ruleIds = new Set<string>();
  const rules: Array<{ id: string; shortDescription: { text: string } }> = [];

  for (const diag of diagnostics) {
    if (!ruleIds.has(diag.ruleId)) {
      ruleIds.add(diag.ruleId);
      rules.push({
        id: diag.ruleId,
        shortDescription: { text: diag.ruleId },
      });
    }
  }

  return rules;
}
