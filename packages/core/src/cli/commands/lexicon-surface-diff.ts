/**
 * `chant dev surface-diff <lexicon-dir>` command implementation.
 *
 * Regenerates a lexicon from its spec, validates the result, extracts the
 * public API surface, and diffs it against the committed baseline snapshot.
 *
 * Outputs a human-readable delta to stdout and optionally a machine-readable
 * JSON result to a file. Never auto-fixes: failures are captured and reported.
 *
 * The snapshot file is written to `<lexicon-dir>/surface.snapshot.json`.
 * Pass `--update-snapshot` to commit the fresh snapshot after a successful run.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { regenLexicon, writeSurfaceSnapshot, SNAPSHOT_FILENAME, type RegenResult } from "../../codegen/lexicon-regen";

// ── Types ─────────────────────────────────────────────────────────────

export interface SurfaceDiffOptions {
  /** Resolved path to the lexicon directory. */
  lexiconDir: string;
  /** Force re-fetch of upstream spec (bypass cache). */
  force?: boolean;
  /** Print subprocess output while running. */
  verbose?: boolean;
  /** Skip the bundle step. */
  skipBundle?: boolean;
  /** Skip the build (tsc) step. */
  skipBuild?: boolean;
  /** Skip chant lint on examples. */
  skipLint?: boolean;
  /** Run the example build harness (opt-in; needs cloud creds). */
  runExamples?: boolean;
  /** Path to a SHA-256 digest file pinning the spec. */
  pinnedDigestPath?: string;
  /** After a successful regen, write the fresh snapshot as the new baseline. */
  updateSnapshot?: boolean;
}

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Run the surface-diff pipeline and return the result.
 * Logs human-readable output to stderr; machine-readable JSON goes to the caller.
 */
export async function runSurfaceDiff(opts: SurfaceDiffOptions): Promise<RegenResult> {
  const dir = resolve(opts.lexiconDir);

  if (!existsSync(dir)) {
    const failure = {
      step: "setup",
      output: `Lexicon directory not found: ${dir}`,
    };
    return {
      ok: false,
      changed: false,
      severity: "none",
      delta: { added: [], changed: [], removed: [], severity: "none" },
      deltaText: "",
      failures: [failure],
      freshSnapshot: null,
    };
  }

  const result = await regenLexicon({
    lexiconDir: dir,
    force: opts.force,
    verbose: opts.verbose,
    skipBundle: opts.skipBundle,
    skipBuild: opts.skipBuild,
    skipLint: opts.skipLint,
    skipExamples: !opts.runExamples,
    pinnedDigestPath: opts.pinnedDigestPath,
  });

  // Update snapshot when requested and the run succeeded
  if (opts.updateSnapshot && result.ok && result.freshSnapshot) {
    writeSurfaceSnapshot(dir, result.freshSnapshot);
    process.stderr.write(`Snapshot updated: ${dir}/${SNAPSHOT_FILENAME}\n`);
  }

  return result;
}

// ── Human-readable output ─────────────────────────────────────────────

const COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function useColors(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

function c(text: string, code: string): string {
  return useColors() ? `${code}${text}${COLORS.reset}` : text;
}

/**
 * Print the surface-diff result as human-readable text to stdout.
 */
export function printSurfaceDiffResult(result: RegenResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(
      {
        ok: result.ok,
        changed: result.changed,
        severity: result.severity,
        delta: result.delta,
        failures: result.failures,
      },
      null,
      2,
    ));
    return;
  }

  // Surface delta
  if (result.deltaText) {
    console.log(result.deltaText);
  } else if (result.changed) {
    console.log("Surface changed (no baseline to diff against).");
  } else {
    console.log(c("No surface changes.", COLORS.green));
  }

  // Failures
  if (result.failures.length > 0) {
    console.log("");
    console.log(c(`${result.failures.length} step(s) failed:`, COLORS.bold));
    for (const f of result.failures) {
      console.log(c(`  FAIL [${f.step}]${f.exitCode !== undefined ? ` (exit ${f.exitCode})` : ""}`, COLORS.red));
      if (f.output) {
        const indented = f.output
          .split("\n")
          .map((l) => `       ${l}`)
          .join("\n");
        console.log(c(indented, COLORS.gray));
      }
    }
  }

  console.log("");

  // Summary line
  const severityColor =
    result.severity === "breaking" ? COLORS.red :
    result.severity === "additive" ? COLORS.yellow :
    COLORS.green;

  const statusLabel = result.ok ? c("ok", COLORS.green) : c("FAILED", COLORS.red);
  const severityLabel = c(result.severity, severityColor);

  console.log(`Status: ${statusLabel}  Severity: ${severityLabel}  Changed: ${result.changed}`);
}
