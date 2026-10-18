/**
 * The time budget of the overlap report (#4025).
 *
 * `chant workspace status --json` reports `overlap`: the in-flight work items
 * whose linked commits touch the same files or reach the same change-set
 * entry. This script times that read on chant's own repository against
 * `chant workspace status <env> --json` on the same machine, and fails when
 * it takes longer than the budget, a ratio of the two medians, measured as
 * `bench-trace.ts` measures the trace (#4032): each command `--runs` times,
 * interleaved, after one unmeasured warm-up of each.
 *
 * chant's own declaration names no work kind, so its overlap would be empty
 * and cost nothing. The script reads a clone of the repository instead
 * (`git clone --shared`, so no object is copied), with its history, its
 * branches and its `chant/lifecycle` branch as a local branch, and adds the
 * reference workspace's work kind, {@link ITEMS} in-flight work items, and
 * {@link BRANCHES} branches of {@link COMMITS_PER_BRANCH} commits each, every
 * commit linked to an item by a `Chant-Record` trailer and touching files
 * other items touch too. The overlap read then walks the whole history of
 * every branch, judges each linked commit and reads the files it touches.
 * Nothing is written to the checkout the script runs in, and the clone is
 * removed afterwards.
 *
 * Both commands run through the same launcher (`node --import tsx`), so the
 * cost of starting node is in both. The overlap read runs as this script's
 * `--read <dir>` mode, which loads the declaration and calls `readOverlap`
 * the way `workspace status` does, with no change sets (the clone's gates
 * bind none).
 *
 *   npx tsx scripts/bench-overlap.ts [--runs 5] [--budget 1] [--env prod] [--json]
 *
 * Exit 0 when the read is within budget, 1 when it is over or a command
 * failed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge } from "./bench-trace";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The overlap read may take at most this many times as long as `workspace
 * status`, median against median. On a developer machine it takes about half
 * (0.48x and 0.53x in two runs), most of it starting node and loading chant,
 * so the budget leaves twice that as margin for a shared runner.
 */
export const OVERLAP_BUDGET_RATIO = 1;

/** The in-flight work items, branches and commits the clone gets. */
export const ITEMS = 20;
export const BRANCHES = 20;
export const COMMITS_PER_BRANCH = 3;

export interface OverlapBenchOptions {
  runs: number;
  budget: number;
  env: string;
  json: boolean;
}

export function parseArgs(argv: string[]): OverlapBenchOptions {
  const opts: OverlapBenchOptions = { runs: 5, budget: OVERLAP_BUDGET_RATIO, env: "prod", json: false };
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
    else if (a === "--json") opts.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!(opts.budget > 0)) throw new Error("--budget must be a positive number");
  return opts;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** One work record of the reference work kind, in flight: it implements no decision. */
export function workRecord(id: string): string {
  const data = {
    schema: 1,
    id,
    title: `Bench item ${id}`,
    state: "in-progress",
    implements: [],
    needs: [],
    constrains: ["member:docs"],
    evidence: [],
    owner: "bench",
    opened_on: "2026-10-01",
    source: { kind: "workspace", member: "docs" },
    supersedes: [],
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

/** Clone the repository into `dir` and give the clone work items and linked branches. Returns the clone. */
export function buildClone(dir: string): string {
  const clone = join(dir, "chant");
  git(dir, "clone", "--shared", "--quiet", repoRoot, clone);
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/chant/lifecycle"], { cwd: clone }).status === 0) {
    git(clone, "branch", "--quiet", "chant/lifecycle", "origin/chant/lifecycle");
  }
  const ref = (p: string) => readFileSync(join(repoRoot, "reference-workspace", p), "utf-8");
  mkdirSync(join(clone, "work"), { recursive: true });
  writeFileSync(
    join(clone, "work", "work.kind.mjs"),
    ref("work/work.kind.mjs").replace('    answers: "../answers/answer.kind.mjs",\n', "").replace('"../decisions/decision.kind.mjs"', '"../docs/design/decisions/decision.kind.mjs"'),
  );
  writeFileSync(join(clone, "work", "work.schema.json"), ref("work/work.schema.json"));
  const ids = Array.from({ length: ITEMS }, (_, i) => `W-${String(i + 1).padStart(3, "0")}`);
  for (const id of ids) writeFileSync(join(clone, "work", `${id}-bench.md`), workRecord(id));
  const declFile = join(clone, "chant.workspace.json");
  const decl = JSON.parse(readFileSync(declFile, "utf-8")) as { records?: { kind: string }[] };
  decl.records = [...(decl.records ?? []), { kind: "work/work.kind.mjs" }];
  writeFileSync(declFile, `${JSON.stringify(decl, null, 2)}\n`);
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "bench: a work kind and its items");
  const base = git(clone, "rev-parse", "--abbrev-ref", "HEAD");
  const pool = git(clone, "ls-files", "packages/core/src/workspace").split("\n").filter((f) => f.endsWith(".ts")).slice(0, BRANCHES * 2);
  for (let b = 0; b < BRANCHES; b++) {
    git(clone, "checkout", "--quiet", "-b", `bench/w-${b}`, base);
    for (let c = 0; c < COMMITS_PER_BRANCH; c++) {
      const file = pool[(b * 2 + c) % pool.length];
      appendFileSync(join(clone, file), `// bench ${b} ${c}\n`);
      git(clone, "commit", "--quiet", "-am", `bench ${b} ${c}`, "--trailer", `Chant-Record: work:${ids[b % ids.length]}`);
    }
  }
  git(clone, "checkout", "--quiet", base);
  return clone;
}

function run(cwd: string, args: string[]): number {
  const started = process.hrtime.bigint();
  // The clone has no node_modules, so tsx is named by its resolved URL.
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), ...args], { cwd, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = undefined;
  }
  if (r.error || doc === undefined || doc === null || (typeof doc === "object" && "error" in doc)) {
    throw new Error(`${args.join(" ")} failed (exit ${r.status}): ${r.error?.message ?? r.stderr.slice(0, 2000)}`);
  }
  return ms;
}

/** `--read <dir>`: the overlap read alone, as `workspace status` makes it, printed as JSON. */
async function read(dir: string): Promise<number> {
  const { readDeclaration } = await import("../packages/core/src/workspace/declaration");
  const { gitTop, workingTree } = await import("../packages/core/src/workspace/tree");
  const { readOverlap } = await import("../packages/core/src/workspace/overlap");
  const root = realpathSync(dir);
  const declaration = readDeclaration(workingTree(root), "", { rootChant: true });
  const report = await readOverlap({ declaration, root, top: gitTop(root)!, changeSets: [] });
  console.log(JSON.stringify(report));
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--read") return read(argv[1] ?? ".");
  const opts = parseArgs(argv);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-bench-overlap-")));
  try {
    const clone = buildClone(scratch);
    const statusArgs = [join(repoRoot, "packages/core/src/cli/main.ts"), "workspace", "status", opts.env, "--json"];
    const readArgs = [fileURLToPath(import.meta.url), "--read", clone];
    run(clone, statusArgs);
    run(clone, readArgs);
    const statusRuns: number[] = [];
    const readRuns: number[] = [];
    for (let i = 0; i < opts.runs; i++) {
      statusRuns.push(run(clone, statusArgs));
      readRuns.push(run(clone, readArgs));
    }
    const result = judge(opts.budget, statusRuns, new Map([["overlap", readRuns]]));
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
      const t = result.targets[0];
      console.log(`workspace status ${opts.env} --json: median ${s(result.status.medianMs)} of ${opts.runs}`);
      console.log(`overlap read (${ITEMS} items, ${BRANCHES * COMMITS_PER_BRANCH} linked commits): median ${s(t.medianMs)}, ${t.ratio.toFixed(2)}x status (budget ${opts.budget}x) ${t.withinBudget ? "ok" : "OVER BUDGET"}`);
    }
    if (!result.ok) console.error(`bench-overlap: the overlap read is over its budget of ${opts.budget}x workspace status`);
    return result.ok ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`bench-overlap: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
