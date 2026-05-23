/**
 * `chant migrate` command implementation.
 *
 * Dispatches to the target lexicon's `migrationSource(from)` extension hook.
 * The lexicon owns the actual translation logic; core orchestrates I/O,
 * stdout/stderr surfaces, and exit codes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatError, formatInfo } from "../format";
import type { LexiconPlugin } from "../../lexicon";

export interface MigrateCliOpts {
  sourceFile: string;
  from: string;
  to: string;
  emit: "yaml" | "ts";
  strict: boolean;
  validate: boolean;
  useComposites: boolean;
  output?: string;
  reportFile?: string;
  plugins: LexiconPlugin[];
}

export interface MigrateCliResult {
  exitCode: number;
  /** Bytes written (output) if any */
  output?: string;
  /** All diagnostic records */
  diagnostics: Array<Record<string, unknown>>;
  /** Provenance records (used for SARIF + Markdown report) */
  provenance: Array<Record<string, unknown>>;
  /** Error message if dispatch failed */
  error?: string;
  /** Markdown summary lines printed to stderr */
  markdownSummary?: string;
}

export async function migrateCommand(opts: MigrateCliOpts): Promise<MigrateCliResult> {
  const targetPlugin = opts.plugins.find((p) => p.name === opts.to);
  if (!targetPlugin) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Target lexicon "${opts.to}" is not installed`,
    };
  }
  if (!targetPlugin.migrationSource) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Lexicon "${opts.to}" does not support migration`,
    };
  }
  const source = targetPlugin.migrationSource(opts.from);
  if (!source) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Lexicon "${opts.to}" does not support migration from "${opts.from}"`,
    };
  }

  let content: string;
  try {
    content = readFileSync(opts.sourceFile, "utf-8");
  } catch (err) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Cannot read ${opts.sourceFile}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!source.detect(content)) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Input file ${opts.sourceFile} does not look like ${opts.from} source`,
    };
  }

  let result;
  try {
    result = await source.transform(content, {
      emit: opts.emit,
      useComposites: opts.useComposites,
      sourceFile: opts.sourceFile,
      strict: opts.strict,
    });
  } catch (err) {
    return {
      exitCode: 1,
      diagnostics: [],
      provenance: [],
      error: `Transformation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write output (--output file or stdout)
  if (opts.output && opts.output !== "-") {
    try {
      writeFileSync(opts.output, result.output);
    } catch (err) {
      return {
        exitCode: 1,
        diagnostics: result.diagnostics,
        provenance: result.provenance,
        error: `Cannot write ${opts.output}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    process.stdout.write(result.output);
  }

  // Markdown summary (always to stderr — leaves stdout clean for piping)
  const markdownSummary = formatMarkdownSummary(result.provenance, result.diagnostics);

  // Determine exit code: any error-severity diagnostic fails when --strict
  const errorDiagnostics = result.diagnostics.filter((d) => d.severity === "error");
  const exitCode = opts.strict && errorDiagnostics.length > 0 ? 1 : 0;

  return {
    exitCode,
    output: result.output,
    diagnostics: result.diagnostics,
    provenance: result.provenance,
    markdownSummary,
  };
}

function formatMarkdownSummary(
  provenance: Array<Record<string, unknown>>,
  diagnostics: Array<Record<string, unknown>>,
): string {
  const totals = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) {
    const sev = d.severity as string;
    if (sev === "error" || sev === "warning" || sev === "info") {
      totals[sev]++;
    }
  }
  const lines: string[] = [];
  lines.push("");
  lines.push("## Migration report");
  lines.push("");
  lines.push(`- Provenance records: ${provenance.length}`);
  lines.push(`- Diagnostics: ${totals.error} error, ${totals.warning} warning, ${totals.info} info`);
  if (diagnostics.length > 0) {
    lines.push("");
    lines.push("| Severity | Rule | Message |");
    lines.push("|---|---|---|");
    for (const d of diagnostics.slice(0, 50)) {
      lines.push(`| ${d.severity} | ${d.ruleId} | ${String(d.message).slice(0, 120)} |`);
    }
    if (diagnostics.length > 50) {
      lines.push(`| … | … | ${diagnostics.length - 50} more diagnostics omitted |`);
    }
  }
  return lines.join("\n");
}

export function printMigrateResult(result: MigrateCliResult): void {
  if (result.error) {
    console.error(formatError({ message: result.error }));
    return;
  }
  if (result.markdownSummary) {
    console.error(result.markdownSummary);
  }
  if (result.exitCode === 0) {
    console.error(formatInfo("\nMigration complete."));
  } else {
    console.error(formatError({ message: "Migration completed with errors (--strict)" }));
  }
}
