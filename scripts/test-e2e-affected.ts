/**
 * The e2e tests a change touches, run before it merges (#4217).
 *
 * Pull requests run only the unit project; the e2e project runs on main in
 * release-suites.yml. On 2026-10-21 three changes merged with their unit tests
 * passing and broke e2e files nobody had run (#4205, #4207), and each cost a
 * suites round on main. This picks the e2e files a diff reaches and runs them:
 *
 * - every changed `*.e2e.test.ts`;
 * - every e2e file in the same directory as a changed file;
 * - the e2e files vitest's import graph relates to the diff (`--changed`),
 *   unless `--no-related`;
 * - the three example gates ({@link EXAMPLE_GATES}) whenever the diff touches
 *   an example, a lexicon serializer or the docs ({@link touchesExamples}).
 *
 * Usage: tsx scripts/test-e2e-affected.ts [base] [--no-related] [--list]
 * Base defaults to origin/main. `--list` prints the files and runs nothing.
 * It prints the file list first and a one-line summary last, for a PR body.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The corpus walkers a new example, serializer change or docs change can break. */
export const EXAMPLE_GATES = [
  "examples/root-examples-gate.e2e.test.ts",
  "examples/sandbox-execution-boundary.e2e.test.ts",
  "examples/fold-differential.e2e.test.ts",
] as const;

const E2E = /\.e2e\.test\.ts$/;

/** Whether a changed path can break the example gates. */
export function touchesExamples(path: string): boolean {
  return (
    path.startsWith("examples/") ||
    /^lexicons\/[^/]+\/examples\//.test(path) ||
    /^lexicons\/[^/]+\/src\/serializer[^/]*$/.test(path) ||
    path.startsWith("docs/")
  );
}

export interface Selection {
  /** The e2e files to run, sorted. */
  files: string[];
  /** Why each file was picked, by file. */
  reasons: Record<string, string>;
}

/**
 * The e2e files a diff reaches. Pure: `changed` is the diff's paths, `e2eFiles`
 * every e2e file in the repository, `related` what vitest's import graph found,
 * all relative to the repository root.
 */
export function selectE2eFiles(input: { changed: readonly string[]; e2eFiles: readonly string[]; related?: readonly string[] }): Selection {
  const known = new Set(input.e2eFiles);
  const reasons: Record<string, string> = {};
  const add = (file: string, reason: string) => {
    if (known.has(file) && !(file in reasons)) reasons[file] = reason;
  };
  const dirs = new Set(input.changed.map((p) => dirname(p)));
  for (const path of input.changed) if (E2E.test(path)) add(path, "changed");
  for (const file of input.e2eFiles) if (dirs.has(dirname(file))) add(file, "same directory as a change");
  if (input.changed.some(touchesExamples)) for (const gate of EXAMPLE_GATES) add(gate, "example gate");
  for (const file of input.related ?? []) add(file, "imports a change");
  return { files: Object.keys(reasons).sort(), reasons };
}

function git(args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

function related(base: string): string[] {
  const out = spawnSync("npx", ["vitest", "list", "--project", "e2e", "--changed", base, "--filesOnly", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`vitest list --changed ${base} failed:\n${out.stderr}`);
  const start = out.stdout.indexOf("[");
  const listed = JSON.parse(start >= 0 ? out.stdout.slice(start) : "[]") as Array<{ file: string }>;
  return listed.map((f) => relative(root, f.file));
}

function main(argv: string[]): number {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const base = argv.find((a) => !a.startsWith("--")) ?? "origin/main";
  const changed = git(["diff", "--name-only", `${base}...HEAD`]).concat(git(["diff", "--name-only", "HEAD"]));
  const e2eFiles = git(["ls-files", "*.e2e.test.ts"]);
  const sel = selectE2eFiles({ changed, e2eFiles, related: flags.has("--no-related") ? [] : related(base) });

  console.log(`e2e files the diff against ${base} reaches (${sel.files.length}):`);
  for (const f of sel.files) console.log(`  ${f}  (${sel.reasons[f]})`);
  if (sel.files.length === 0) {
    console.log(`test-e2e-affected: no e2e file is affected by the diff against ${base}.`);
    return 0;
  }
  if (flags.has("--list")) return 0;

  const run = spawnSync("npx", ["vitest", "run", "--project", "e2e", ...sel.files], { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(run.stdout ?? "");
  const tests = /Tests\s+(.+?)\s*\(\d+\)/.exec((run.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? "no test count";
  const verdict = run.status === 0 ? "passed" : "FAILED";
  console.log(`test-e2e-affected: ${sel.files.length} e2e file(s) against ${base} ${verdict} (${tests}).`);
  return run.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
