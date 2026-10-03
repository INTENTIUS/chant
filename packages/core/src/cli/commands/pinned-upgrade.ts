/**
 * `chant dev pinned-upgrade <lexicon-dir>` command implementation.
 *
 * Detects whether a lexicon that declares `upstreamPin` has a
 * newer stable upstream release. When it does, it dry-run bumps the pinned
 * version constant, regenerates + surface-diffs (via #524's regenLexicon), then
 * reverts the bump — leaving the working tree unchanged.
 *
 * This command only REPORTS. Branch/PR automation lives in #527.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import {
  checkPinnedUpgrade,
  lexiconNameOf,
  type LexiconId,
  type UpgradeCheckResult,
} from "../../codegen/pinned-upgrade";

export interface PinnedUpgradeOptions {
  /** Resolved path to the lexicon directory. */
  lexiconDir: string;
  /** Explicit lexicon id; inferred from the directory name when omitted. */
  lexicon?: LexiconId;
  /** Force re-fetch of the upstream spec during regen. */
  force?: boolean;
  /** Print subprocess output while running. */
  verbose?: boolean;
}

/**
 * Infer the lexicon id from a directory: its package name
 * (`@intentius/chant-lexicon-<name>`), else the directory name. Whether the
 * lexicon is pinned is the plugin's `upstreamPin`, checked by
 * `checkPinnedUpgrade`, not a list here.
 */
export function inferLexicon(lexiconDir: string): LexiconId {
  return lexiconNameOf(lexiconDir);
}

/**
 * Map a regen severity to a semver review label.
 * additive → "minor"; breaking → "major"; none → "none".
 */
export function semverLabel(result: UpgradeCheckResult): "minor" | "major" | "none" {
  const sev = result.validation?.severity;
  if (sev === "breaking") return "major";
  if (sev === "additive") return "minor";
  return "none";
}

/**
 * Run the pinned-upgrade check and return the structured result.
 * Never throws — a missing dir or a lexicon with no `upstreamPin` becomes a fetchError.
 */
export async function runPinnedUpgrade(opts: PinnedUpgradeOptions): Promise<UpgradeCheckResult> {
  const dir = resolve(opts.lexiconDir);

  const lexicon = opts.lexicon ?? inferLexicon(dir);

  if (!existsSync(dir)) {
    return {
      lexicon,
      hasUpgrade: false,
      from: "(unknown)",
      to: null,
      validation: null,
      fetchError: `Lexicon directory not found: ${dir}`,
    };
  }

  return checkPinnedUpgrade({
    lexiconDir: dir,
    lexicon,
    force: opts.force,
    verbose: opts.verbose,
  });
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
 * Print the pinned-upgrade result. `json` emits a machine-readable object.
 */
export function printPinnedUpgradeResult(result: UpgradeCheckResult, json: boolean): void {
  const label = semverLabel(result);

  if (json) {
    console.log(
      JSON.stringify(
        {
          lexicon: result.lexicon,
          hasUpgrade: result.hasUpgrade,
          from: result.from,
          to: result.to,
          semver: label,
          severity: result.validation?.severity ?? "none",
          changed: result.validation?.changed ?? false,
          delta: result.validation?.delta ?? null,
          validationOk: result.validation?.ok ?? null,
          failures: result.validation?.failures ?? [],
          fetchError: result.fetchError,
          manualPin: result.manualPin ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (result.fetchError) {
    console.log(c(`[${result.lexicon}] error: ${result.fetchError}`, COLORS.red));
    return;
  }

  if (!result.hasUpgrade) {
    console.log(
      c(`[${result.lexicon}] up to date`, COLORS.green) +
        `  pinned=${result.from}` +
        (result.to ? ` latest=${result.to}` : ""),
    );
    return;
  }

  if (result.manualPin) {
    console.log(
      c(`[${result.lexicon}] upgrade available`, COLORS.bold) + `  ${result.from} -> ${result.to}`,
    );
    console.log(`  The pin in ${result.manualPin.file} cannot be rewritten generically, so nothing was edited or regenerated.`);
    console.log(`  ${result.manualPin.instructions}`);
    return;
  }

  // Upgrade available
  console.log(
    c(`[${result.lexicon}] upgrade available`, COLORS.bold) +
      `  ${result.from} -> ${result.to}`,
  );

  const v = result.validation;
  if (v) {
    // Surface delta
    if (v.deltaText) {
      console.log("");
      console.log(v.deltaText);
    } else if (v.changed) {
      console.log("  Surface changed (no baseline to diff against).");
    } else {
      console.log("  No surface changes.");
    }

    // Failures
    if (v.failures.length > 0) {
      console.log("");
      console.log(c(`  ${v.failures.length} validation step(s) failed:`, COLORS.bold));
      for (const f of v.failures) {
        console.log(
          c(
            `    FAIL [${f.step}]${f.exitCode !== undefined ? ` (exit ${f.exitCode})` : ""}`,
            COLORS.red,
          ),
        );
        if (f.output) {
          const indented = f.output
            .split("\n")
            .map((l) => `         ${l}`)
            .join("\n");
          console.log(c(indented, COLORS.gray));
        }
      }
    }
  }

  console.log("");
  const labelColor =
    label === "major" ? COLORS.red : label === "minor" ? COLORS.yellow : COLORS.green;
  const validationLabel = v
    ? v.ok
      ? c("ok", COLORS.green)
      : c("FAILED", COLORS.red)
    : c("skipped", COLORS.gray);
  console.log(
    `Validation: ${validationLabel}  Semver: ${c(label, labelColor)}  ${result.from} -> ${result.to}`,
  );
}
