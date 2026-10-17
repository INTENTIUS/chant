/**
 * The time budget of a single-resource trace (#4032).
 *
 * `chant workspace graph --intent <region> --json` reads a region's git
 * history, its blame, the records that constrain it and the provenance of
 * each commit. This script times it on chant's own repository against
 * `chant workspace status <env> --json` on the same machine, and fails when
 * a trace takes longer than the budget, stated as a ratio of the two medians.
 *
 * Both commands run through the same launcher (`node --import tsx` on the
 * CLI's source, or `--chant <file>` for a built CLI), so the cost of starting
 * node and loading chant is in both and the ratio measures the trace's own
 * work. Each command runs `--runs` times, interleaved so a slow spell on a
 * shared runner hits every command alike, and the median is compared. The
 * budget carries a margin over what the trace takes on a developer machine,
 * for the same reason.
 *
 *   npx tsx scripts/bench-trace.ts [--runs 5] [--budget 2] [--env prod]
 *     [--target <region>]... [--chant <cli file>] [--json]
 *
 * The trace reads history, so the checkout must be a full clone: a shallow
 * one fails at once rather than time a trace of a cut history. It also needs
 * a base revision (`origin/HEAD`, `main` or `master`), where it reads the
 * signer policy that judges each commit; without one that work is skipped,
 * so the script refuses to run. Exit 0 when every target is within budget, 1
 * when one is over or a command failed.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The trace may take at most this many times as long as `workspace status`, median against median. */
export const TRACE_BUDGET_RATIO = 2;

/**
 * The regions the budget is measured on: the most edited file of the CLI, a
 * file with a single commit, and a symbol in the intent walk itself.
 */
export const DEFAULT_TARGETS = ["packages/core/src/cli/main.ts", "LICENSE", "packages/core/src/workspace/intent.ts#intentGraph"];

export interface BenchOptions {
  runs: number;
  budget: number;
  env: string;
  targets: string[];
  chant: string | null;
  json: boolean;
}

export function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = { runs: 5, budget: TRACE_BUDGET_RATIO, env: "prod", targets: [], chant: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--runs") opts.runs = Number(value());
    else if (a === "--budget") opts.budget = Number(value());
    else if (a === "--env") opts.env = value();
    else if (a === "--target") opts.targets.push(value());
    else if (a === "--chant") opts.chant = value();
    else if (a === "--json") opts.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!(opts.budget > 0)) throw new Error("--budget must be a positive number");
  if (opts.targets.length === 0) opts.targets = [...DEFAULT_TARGETS];
  return opts;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface TargetResult {
  target: string;
  runsMs: number[];
  medianMs: number;
  ratio: number;
  withinBudget: boolean;
}

export interface BenchResult {
  budget: number;
  status: { runsMs: number[]; medianMs: number };
  targets: TargetResult[];
  ok: boolean;
}

/** Judge each target's median against the status median and the budget. */
export function judge(budget: number, statusRuns: number[], targetRuns: Map<string, number[]>): BenchResult {
  const statusMedian = median(statusRuns);
  const targets = [...targetRuns].map(([target, runsMs]) => {
    const medianMs = median(runsMs);
    const ratio = medianMs / statusMedian;
    return { target, runsMs, medianMs, ratio, withinBudget: ratio <= budget };
  });
  return { budget, status: { runsMs: statusRuns, medianMs: statusMedian }, targets, ok: targets.every((t) => t.withinBudget) };
}

function run(opts: BenchOptions, args: string[]): number {
  const launcher = opts.chant ? [opts.chant] : ["--import", "tsx", join(repoRoot, "packages/core/src/cli/main.ts")];
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [...launcher, ...args], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = undefined;
  }
  if (r.error || doc === undefined || (typeof doc === "object" && doc !== null && "error" in doc)) {
    throw new Error(`chant ${args.join(" ")} failed (exit ${r.status}): ${r.error?.message ?? r.stderr.slice(0, 2000)}`);
  }
  return ms;
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot, encoding: "utf-8" }).stdout.trim();
  if (shallow !== "false") {
    console.error("bench-trace: the checkout is shallow or not a git repository; the trace needs the whole history (fetch-depth: 0)");
    return 1;
  }
  // Without a base, the trace judges no commit's signature, and would be timed without that work.
  const base = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"].find(
    (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoRoot }).status === 0,
  );
  if (!base) {
    console.error("bench-trace: no base revision (origin/HEAD, main or master), so the trace would skip provenance; run `git remote set-head origin main` first");
    return 1;
  }
  const statusArgs = ["workspace", "status", opts.env, "--json"];
  const traceArgs = (t: string) => ["workspace", "graph", "--intent", t, "--json"];
  // One warm-up of each, unmeasured, so the first measured run doesn't pay for a cold disk cache.
  run(opts, statusArgs);
  for (const t of opts.targets) run(opts, traceArgs(t));
  const statusRuns: number[] = [];
  const targetRuns = new Map<string, number[]>(opts.targets.map((t) => [t, []]));
  for (let i = 0; i < opts.runs; i++) {
    statusRuns.push(run(opts, statusArgs));
    for (const t of opts.targets) targetRuns.get(t)!.push(run(opts, traceArgs(t)));
  }
  const result = judge(opts.budget, statusRuns, targetRuns);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    console.log(`workspace status ${opts.env} --json: median ${s(result.status.medianMs)} of ${opts.runs}`);
    for (const t of result.targets) {
      console.log(`graph --intent ${t.target}: median ${s(t.medianMs)}, ${t.ratio.toFixed(2)}x status (budget ${opts.budget}x) ${t.withinBudget ? "ok" : "OVER BUDGET"}`);
    }
  }
  if (!result.ok) console.error(`bench-trace: a trace is over its budget of ${opts.budget}x workspace status`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`bench-trace: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
