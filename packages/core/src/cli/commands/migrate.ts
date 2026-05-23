/**
 * `chant migrate` command implementation.
 *
 * Dispatches to the target lexicon's `migrationSource(from)` extension hook.
 * The lexicon owns the actual translation logic; core orchestrates I/O,
 * stdout/stderr surfaces, and exit codes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { formatError, formatInfo } from "../format";
import { formatSarif } from "../reporters/stylish";
import type { LexiconPlugin } from "../../lexicon";
import type { LintRule, LintDiagnostic } from "../../lint/rule";

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

  // External validator (--validate) — glci preferred, glab fallback.
  let validatorWarning: string | undefined;
  if (opts.validate && opts.emit === "yaml") {
    const v = tryValidateExternal(result.output);
    if (!v.ran) {
      validatorWarning = "neither glci nor glab is on PATH; skipping --validate";
      if (opts.strict) {
        return {
          exitCode: 1,
          output: result.output,
          diagnostics: result.diagnostics,
          provenance: result.provenance,
          error: "--strict --validate: neither glci nor glab is on PATH",
        };
      }
    } else if (!v.ok) {
      console.error(`Validator (${v.backend}) reported errors:\n${v.output}`);
      if (opts.strict) {
        return {
          exitCode: 1,
          output: result.output,
          diagnostics: result.diagnostics,
          provenance: result.provenance,
          error: `--strict: ${v.backend} validation failed`,
        };
      }
    } else {
      console.error(`Validator (${v.backend}) OK`);
    }
  }

  // SARIF report (--report <path>) — reuse the lint-side formatSarif so any
  // CI SARIF ingest path treats migration findings uniformly.
  if (opts.reportFile) {
    try {
      const rules = await loadMigrationRules(opts.to);
      const lintShape = result.diagnostics as unknown as LintDiagnostic[];
      const sarif = formatSarif(lintShape, rules);
      writeFileSync(opts.reportFile, sarif);
    } catch (err) {
      // Non-fatal: surface the failure but don't abort the migration
      console.error(`Warning: could not write SARIF report to ${opts.reportFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Markdown summary (always to stderr — leaves stdout clean for piping)
  const markdownSummary = formatMarkdownSummary(result.provenance, result.diagnostics);

  // Determine exit code: any error-severity diagnostic fails when --strict.
  // The transformer already escalates needs-review → error when opts.strict
  // is passed via MigrationSource.transform(); we double-check here.
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

interface ValidatorResult {
  ran: boolean;
  ok: boolean;
  backend?: "glci" | "glab";
  output: string;
}

function isOnPath(cmd: string): boolean {
  // Use the OS-native lookup. `which` exists on macOS/Linux; `where` on Windows.
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, [cmd], { encoding: "utf-8" });
  return r.status === 0;
}

/**
 * Run glci or glab against the generated .gitlab-ci.yml. Prefers glci
 * (offline, no auth). Falls back to glab ci lint. Returns a structured
 * result so the caller can decide how to surface success/failure.
 *
 * Exported for testability.
 */
export function tryValidateExternal(yamlText: string): ValidatorResult {
  if (isOnPath("glci")) {
    const r = spawnSync("glci", ["lint", "-f", "-"], { input: yamlText, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, backend: "glci", output: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  if (isOnPath("glab")) {
    const r = spawnSync("glab", ["ci", "lint", "-f", "-"], { input: yamlText, encoding: "utf-8" });
    return { ran: true, ok: r.status === 0, backend: "glab", output: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  return { ran: false, ok: false, output: "" };
}

/**
 * Lazily load the target lexicon's MIGRATION_RULES (used for SARIF enrichment).
 * Returns an empty array if the lexicon doesn't expose them.
 */
async function loadMigrationRules(targetLexicon: string): Promise<LintRule[]> {
  // For now only gitlab exposes migration rules. Hard-coded import keeps
  // the dependency direction explicit; widen the switch when more
  // lexicons ship their own migrate paths.
  if (targetLexicon === "gitlab") {
    try {
      const mod = await import("@intentius/chant-lexicon-gitlab/migrate/from-github/rules");
      return (mod as { MIGRATION_RULES: LintRule[] }).MIGRATION_RULES;
    } catch {
      return [];
    }
  }
  return [];
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
