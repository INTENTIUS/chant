/**
 * Repo-wide typecheck with a shrinking baseline (#1388).
 *
 * `tsconfig.typecheck.json` covers what the build configs deliberately do not:
 * lexicon tests, lexicon scripts, and examples. Turning that on outright is not
 * available — those populations carry a backlog no one has worked through, and a
 * check that cannot pass is a check nobody runs.
 *
 * So this ratchets. Every file that fails today is listed in
 * `typecheck-baseline.json`; a file **not** in that list failing is an error,
 * and a file in the list that now passes is also an error, with instructions to
 * delete its line. The backlog can only get smaller, and a new test written
 * tomorrow is typechecked from the moment it exists — which is the gap that
 * motivated the issue: a type-level assertion in a lexicon test was evaluated by
 * nothing at all.
 *
 * The same shape as `KNOWN_FAILURES` in check-lexicons.ts: tracked, with a
 * reason, never silently skipped.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(repoRoot, "scripts", "typecheck-baseline.json");
const CONFIG = "tsconfig.typecheck.json";

interface Baseline {
  /** Why this file is exempt, for whoever reads the list next. */
  readonly note: string;
  /** Repo-relative paths that currently fail, sorted. */
  readonly files: string[];
}

/** Run tsc and return the repo-relative files that reported an error. */
function failingFiles(): { files: Set<string>; raw: string } {
  let raw = "";
  try {
    execFileSync("npx", ["tsc", "--noEmit", "-p", CONFIG], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    raw = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const files = new Set<string>();
  for (const line of raw.split("\n")) {
    // `path/to/file.ts(12,34): error TS1234: …` — continuation lines are indented.
    const match = /^([^\s(][^(]*\.(?:ts|tsx|mts|cts))\(\d+,\d+\): error /.exec(line);
    if (match) files.add(relative(repoRoot, join(repoRoot, match[1])));
  }
  return { files, raw };
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { note: "", files: [] };
  return JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
}

function main(): void {
  const write = process.argv.includes("--write-baseline");
  const { files, raw } = failingFiles();

  if (write) {
    const baseline: Baseline = {
      note:
        "Files that fail tsconfig.typecheck.json today (#1388). Only ever remove " +
        "lines from this list — scripts/typecheck.ts fails on a file that is not " +
        "here, and on a file here that now passes.",
      files: [...files].sort(),
    };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.error(`Wrote ${baseline.files.length} file(s) to ${relative(repoRoot, BASELINE)}`);
    return;
  }

  const baseline = new Set(readBaseline().files);
  const regressions = [...files].filter((f) => !baseline.has(f)).sort();
  const fixed = [...baseline].filter((f) => !files.has(f)).sort();

  if (regressions.length > 0) {
    console.error(`\n${regressions.length} file(s) newly failing the repo-wide typecheck:\n`);
    for (const file of regressions) {
      console.error(`  ${file}`);
      for (const line of raw.split("\n")) {
        if (line.startsWith(`${file}(`)) console.error(`    ${line.slice(file.length)}`);
      }
    }
    console.error(
      "\nThese are not in scripts/typecheck-baseline.json, so they are new. Fix them,\n" +
        "or — if the file is genuinely part of the pre-existing backlog — say why in the\n" +
        "PR and add it deliberately.\n",
    );
  }

  if (fixed.length > 0) {
    console.error(`\n${fixed.length} baselined file(s) now typecheck cleanly:\n`);
    for (const file of fixed) console.error(`  ${file}`);
    console.error(
      "\nRemove them from scripts/typecheck-baseline.json so the backlog cannot grow\n" +
        "back into the space they freed.\n",
    );
  }

  if (regressions.length === 0 && fixed.length === 0) {
    console.error(
      `Repo-wide typecheck: ${files.size} known failure(s), no regressions. ` +
        `(${baseline.size} baselined)`,
    );
    return;
  }
  process.exit(1);
}

main();
