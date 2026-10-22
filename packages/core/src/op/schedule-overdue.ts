/**
 * Scheduled watch and reconcile Ops that stopped running (#4289).
 *
 * A schedule can stop with no error anywhere. GitHub turns a scheduled
 * workflow off after 60 days with no activity in the repository and drops
 * scheduled runs under load. A GitLab schedule exists only once someone
 * creates it. A watch Op cannot report its own absence, so the pull-request
 * plan job does. For each discovered Op with a `schedule` and the `Watch` or
 * `Reconcile` label, whose generated pipeline file is in the checkout, it
 * asks the forge when the Op's job last ran. When the cron has fired at
 * least twice since then, or since the pipeline file was added for a job
 * that never ran, the job log and the plan note say the Op is overdue.
 *
 * One late or dropped run is not enough: two fires are. A forge that will
 * not answer is a line in the log and no verdict.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpConfig } from "./types";
import { cronFiresUtc } from "./cron";
import type { ForgeKind, PrForge, ScheduledRuns } from "../pr-forge";

/** One scheduled watch or reconcile Op the plan job checks. */
export interface ScheduledWatch {
  op: string;
  cron: string;
}

/** An Op the plan note warns about. */
export interface OverdueOp {
  op: string;
  cron: string;
  /** The time the count starts from: the job's last run, or the pipeline file's first commit (ISO 8601). */
  since: string;
  /** True when no run is on record and `since` is the pipeline file's first commit. */
  neverRan?: boolean;
  /** The line for the job log and the plan note. */
  message: string;
}

/**
 * The discovered Ops that are scheduled watch or reconcile Ops: a
 * `schedule`, and the `Watch` label `WatchOp` sets (./composites/watch-op.ts)
 * or the `Reconcile` label `ReconcileOp` sets (./composites/reconcile-op.ts).
 * Sorted by name.
 */
export function scheduledWatches(ops: Iterable<OpConfig>): ScheduledWatch[] {
  const out: ScheduledWatch[] = [];
  for (const op of ops) {
    if (!op.schedule?.cron) continue;
    if (op.labels?.Watch !== "true" && op.labels?.Reconcile !== "true") continue;
    out.push({ op: op.name, cron: op.schedule.cron });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

/**
 * The file `chant run --generate <forge>` writes for an Op, relative to the
 * repository root: `<dir>/<op>.yml` on GitHub and Forgejo, `<member>-<op>.yml`
 * in a workspace member. GitLab puts every Op in one file, so the root's
 * `*.gitlab-ci.yml` files are read for the one whose rules select the Op.
 * Undefined when the checkout has no such file, so an Op that some other
 * scheduler runs is never checked.
 */
export function opPipelineFile(repoRoot: string, forge: ForgeKind, op: string, member?: string): string | undefined {
  const base = member ? `${member}-${op}` : op;
  if (forge === "github" || forge === "forgejo") {
    const path = `.${forge}/workflows/${base}.yml`;
    return existsSync(join(repoRoot, path)) ? path : undefined;
  }
  // The gitlab lexicon's cron rule: `$CHANT_SCHEDULED_OP == "<op>"`.
  const selector = `$CHANT_SCHEDULED_OP == "${op}"`;
  let names: string[];
  try {
    names = readdirSync(repoRoot).filter((n) => n.endsWith(".gitlab-ci.yml")).sort();
  } catch {
    return undefined;
  }
  return names.find((n) => {
    try {
      return readFileSync(join(repoRoot, n), "utf8").includes(selector);
    } catch {
      return false;
    }
  });
}

/** When `path` was first committed (ISO 8601), if the checkout's history has it. */
export function fileAdded(repoRoot: string, path: string): string | undefined {
  const r = spawnSync("git", ["-C", repoRoot, "log", "--format=%cI", "--diff-filter=A", "--", path], { encoding: "utf-8" });
  if (r.status !== 0) return undefined;
  return r.stdout.trim().split("\n").filter(Boolean).pop();
}

const HINT: Record<ForgeKind, string> = {
  github: "GitHub turns a scheduled workflow off after 60 days with no activity in the repository. Turn the workflow on again under Actions, or run it by hand",
  gitlab: "A GitLab project runs a scheduled Op only from a pipeline schedule. Check its schedule under CI/CD > Schedules",
  forgejo: "Check that Actions is on for the repository and a runner is up, or run the workflow by hand",
};

/**
 * Whether one Op is overdue: its cron has fired at least twice since its
 * last run, or since `added` when no run is on record. Undefined when it is
 * on time, or when nothing says when it should have run.
 */
export function overdueVerdict(watch: ScheduledWatch, forge: ForgeKind, runs: ScheduledRuns, added: string | undefined, now: Date): OverdueOp | undefined {
  const since = runs.last ?? added;
  if (!since) return undefined;
  if (cronFiresUtc(watch.cron, new Date(since), now, 2).length < 2) return undefined;
  const day = since.slice(0, 10);
  const what = runs.last ? `its last run was on ${day}` : `no run is on record since its pipeline was added on ${day}`;
  const why = runs.disabled
    ? `GitHub has turned the workflow off (${runs.disabled}). Turn it on again under Actions`
    : forge === "gitlab" && runs.noSchedule
      ? `No active pipeline schedule sets CHANT_SCHEDULED_OP to ${watch.op}. Add one with the cron \`${watch.cron}\` under CI/CD > Schedules`
      : HINT[forge];
  return {
    op: watch.op,
    cron: watch.cron,
    since,
    ...(runs.last ? {} : { neverRan: true }),
    message: `Op \`${watch.op}\` is overdue: its schedule \`${watch.cron}\` has fired at least twice and ${what}. ${why}.`,
  };
}

/**
 * The plan job's check over every scheduled watch or reconcile Op that has a
 * generated pipeline file. Each Op the forge will not answer for is a line
 * in `log` and no verdict. A forge client with no `scheduledRuns` checks
 * nothing.
 */
export async function checkOverdueOps(input: {
  watches: readonly ScheduledWatch[];
  forge: PrForge;
  repoRoot: string;
  member?: string;
  now: Date;
  log: (line: string) => void;
}): Promise<OverdueOp[]> {
  const { forge } = input;
  if (!forge.scheduledRuns) return [];
  const out: OverdueOp[] = [];
  for (const watch of input.watches) {
    const file = opPipelineFile(input.repoRoot, forge.kind, watch.op, input.member);
    if (!file) continue;
    let runs: ScheduledRuns;
    try {
      runs = await forge.scheduledRuns({ op: watch.op, workflow: file.split("/").pop()! });
    } catch (err) {
      input.log(`schedule check: ${forge.kind} did not say when Op ${watch.op} last ran, so it is not checked: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      continue;
    }
    const found = overdueVerdict(watch, forge.kind, runs, runs.last ? undefined : fileAdded(input.repoRoot, file), input.now);
    if (found) {
      input.log(found.message);
      out.push(found);
    }
  }
  return out;
}
