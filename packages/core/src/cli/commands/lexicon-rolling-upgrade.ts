/**
 * `chant dev rolling-upgrade <lexicon-dir>` command implementation.
 *
 * Detects rolling-spec drift for the aws, azure, and github lexicons. These
 * lexicons pin no version constant — "latest" is fetched on every regen. This
 * command regenerates from current-latest, diffs the produced API surface
 * against the committed baseline (surface.snapshot.json), and REPORTS the
 * result. It is a dry run: it never opens a PR, updates a branch, or writes the
 * baseline. PR automation and scheduling live in #527.
 *
 * The PR label an eventual automation would apply is derived from severity:
 *   additive → `minor`, breaking → `major`. This command only prints it.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import {
  checkRollingUpgrade,
  type RollingUpgradeResult,
} from "../../codegen/rolling-upgrade";

// ── Types ─────────────────────────────────────────────────────────────

export interface RollingUpgradeCliOptions {
  /** Resolved path to the lexicon directory. */
  lexiconDir: string;
  /** Force re-fetch of the upstream spec (bypass cache). */
  force?: boolean;
  /** Print subprocess output while running. */
  verbose?: boolean;
}

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Run the rolling-upgrade check and return the result.
 * Returns a synthetic failed result when the directory is missing.
 */
export async function runRollingUpgrade(
  opts: RollingUpgradeCliOptions,
): Promise<RollingUpgradeResult> {
  const dir = resolve(opts.lexiconDir);

  if (!existsSync(dir)) {
    return {
      lexicon: "aws",
      hasUpgrade: false,
      severity: "none",
      delta: { added: [], changed: [], removed: [], severity: "none" },
      deltaText: "",
      validationOk: false,
      failures: [{ step: "setup", output: `Lexicon directory not found: ${dir}` }],
      apiVersionDelta: [],
      freshSnapshot: null,
    };
  }

  return checkRollingUpgrade({
    lexiconDir: dir,
    force: opts.force,
    verbose: opts.verbose,
  });
}

/**
 * Map surface severity to the semver PR label an upgrade would carry.
 * additive → minor, breaking → major, none → none.
 */
export function severityToLabel(severity: RollingUpgradeResult["severity"]): string {
  if (severity === "breaking") return "major";
  if (severity === "additive") return "minor";
  return "none";
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
 * Print the rolling-upgrade result to stdout.
 */
export function printRollingUpgradeResult(result: RollingUpgradeResult, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          lexicon: result.lexicon,
          hasUpgrade: result.hasUpgrade,
          severity: result.severity,
          label: severityToLabel(result.severity),
          validationOk: result.validationOk,
          delta: result.delta,
          apiVersionDelta: result.apiVersionDelta,
          failures: result.failures,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(c(`Rolling upgrade check: ${result.lexicon}`, COLORS.bold));
  console.log("");

  // Surface delta — the review payload
  if (result.deltaText) {
    console.log(result.deltaText);
  } else {
    console.log(c("No surface changes.", COLORS.green));
  }

  // azure API-version delta
  if (result.apiVersionDelta.length > 0) {
    console.log("");
    console.log(c(`API version changes (${result.apiVersionDelta.length}):`, COLORS.bold));
    for (const v of result.apiVersionDelta) {
      const arrow =
        v.kind === "added"
          ? `+ ${v.provider} (${v.after})`
          : v.kind === "removed"
            ? `- ${v.provider} (was ${v.before})`
            : `~ ${v.provider}: ${v.before} -> ${v.after}`;
      console.log(`  ${arrow}`);
    }
  }

  // Failures
  if (result.failures.length > 0) {
    console.log("");
    console.log(c(`${result.failures.length} step(s) failed:`, COLORS.bold));
    for (const f of result.failures) {
      console.log(
        c(
          `  FAIL [${f.step}]${f.exitCode !== undefined ? ` (exit ${f.exitCode})` : ""}`,
          COLORS.red,
        ),
      );
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

  // Decision line
  const severityColor =
    result.severity === "breaking"
      ? COLORS.red
      : result.severity === "additive"
        ? COLORS.yellow
        : COLORS.green;

  const label = severityToLabel(result.severity);
  const validationLabel = result.validationOk
    ? c("ok", COLORS.green)
    : c("FAILED", COLORS.red);

  console.log(
    `Upgrade: ${result.hasUpgrade}  Severity: ${c(result.severity, severityColor)}  ` +
      `Label: ${label}  Validation: ${validationLabel}`,
  );

  if (result.hasUpgrade && result.validationOk) {
    console.log(
      c(
        `A PR would be opened: chore(${result.lexicon}): regen from latest spec [${label}]`,
        COLORS.gray,
      ),
    );
  } else if (result.hasUpgrade && !result.validationOk) {
    console.log(
      c("Surface moved but validation failed — no PR; surfaces as a report/issue (#527).", COLORS.yellow),
    );
  } else {
    console.log(c("No surface change — no PR.", COLORS.gray));
  }
}
