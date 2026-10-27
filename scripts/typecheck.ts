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
 *
 * **Regenerate the baseline only after `prepack`.** Lexicon types are generated,
 * so a clone with stale or partial `src/generated/` reports failures that do not
 * exist in CI, which runs every lexicon's prepack first. Writing the baseline in
 * that state captured 33 phantom entries on the first attempt — the run went
 * green locally and then failed in CI with "33 baselined files now typecheck
 * cleanly", which is the ratchet working exactly as intended, on its own author.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    execFileSync(join(repoRoot, "scripts", "tsc7.sh"), ["--noEmit", "--declaration", "false", "--declarationMap", "false", "-p", CONFIG], {
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

/**
 * Lexicons whose own tsconfig.json must typecheck their tests, cleanly (chant #4511).
 *
 * A lexicon's tsconfig.json with no `exclude` inherits the root's `**\/*.test.ts`, so
 * `tsc -p lexicons/<name>` (and an editor on that config) never saw the tests. Each
 * lexicon named here sets its own exclude. This pass runs that config with no baseline
 * and also fails if a test file on disk is missing from the program, so an exclude that
 * drops tests again shows up here instead of going quiet.
 */
const LEXICON_TEST_CONFIGS: readonly string[] = ["lexicons/terraform"];

/** `*.test.ts` files under `dir`, repo-relative, skipping node_modules, dist and docs. */
function testFilesUnder(dir: string): string[] {
  const entries = readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf-8" });
  return entries
    .map((entry) => join(dir, entry))
    .filter((file) => file.endsWith(".test.ts"))
    .filter((file) => !/(^|\/)(node_modules|dist|docs)\//.test(file))
    .sort();
}

/** Typecheck one lexicon's tsconfig.json; return the problems found, empty when clean. */
function lexiconTestProblems(dir: string): string[] {
  let out = "";
  let failed = false;
  try {
    out = execFileSync(
      join(repoRoot, "scripts", "tsc7.sh"),
      ["--noEmit", "--declaration", "false", "--declarationMap", "false", "--listFiles", "-p", dir],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    failed = true;
  }
  const lines = out.split("\n");
  const problems = lines.filter((line) => /\): error TS\d+:/.test(line));
  if (failed && problems.length === 0) problems.push(`tsc -p ${dir} failed:\n${out}`);
  const listed = new Set(lines.filter((line) => line.startsWith("/")).map((line) => relative(repoRoot, line.trim())));
  for (const file of testFilesUnder(dir)) {
    if (!listed.has(file)) problems.push(`${file} is not in tsc -p ${dir}'s program`);
  }
  return problems;
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { note: "", files: [] };
  return JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
}

function main(): void {
  const write = process.argv.includes("--write-baseline");
  if (write) {
    console.error(
      "Regenerating the baseline. Run every lexicon's prepack first — generated\n" +
        "types are not committed, and a stale clone records failures CI will not see.\n",
    );
  }
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

  const lexiconProblems = LEXICON_TEST_CONFIGS.flatMap((dir) => lexiconTestProblems(dir));
  if (lexiconProblems.length > 0) {
    console.error(`\n${lexiconProblems.length} problem(s) in the lexicon test configs (#4511):\n`);
    for (const problem of lexiconProblems) console.error(`  ${problem}`);
    console.error(
      "\nEach config in LEXICON_TEST_CONFIGS must typecheck every test file under it with\n" +
        "no errors. There is no baseline for these.\n",
    );
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

  if (regressions.length === 0 && fixed.length === 0 && lexiconProblems.length === 0) {
    console.error(
      `Repo-wide typecheck: ${files.size} known failure(s), no regressions. ` +
        `(${baseline.size} baselined; ${LEXICON_TEST_CONFIGS.join(", ")} test configs clean)`,
    );
    return;
  }
  process.exit(1);
}

main();
