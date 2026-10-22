/**
 * Stage hooks on the pull-request path (#4288): `ci.hooks` in the workspace
 * declaration, run by `chant components pr-plan`, `pr-record` and
 * `pr-apply` with the runner an Op waves job uses (`runStageHooks`).
 *
 * The hooks are read from the declaration at the base the job measures the
 * change from, never from the change itself, so a pull request cannot add,
 * edit or remove a hook its own jobs run. The top level's hooks run first,
 * then those of the member the job runs in. When the base has no workspace
 * declaration no hook runs. When the declaration at base cannot be read and
 * the working tree's names hooks, the job refuses to run rather than guess.
 *
 * The runs a hook sees are the components the change selects, in apply
 * order: `{target}` and `CHANT_TARGET` name one, and `targets` match their
 * names. After the plan, a `perRun` hook's `{plan}` is a JSON file with that
 * component's members and the plans its steps hand the apply.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { OpWaveHook, OpWaveHookMoment, OpWaveHooks } from "../op/op-waves";
import { PR_LOOP_HOOK_MOMENTS } from "../op/op-waves";
import { runStageHooks, type OpWaveExec, type OpWaveHookRun, type StageHooksRun } from "../op/op-waves-run";
import { readDeclaration, WorkspaceReadError, type Declaration } from "../workspace/declaration";
import { memberAtCwd } from "../workspace/security";
import { locateWorkspace } from "../workspace/which-chant";
import type { PrHookOutcome, PrMember } from "../pr-loop";

/** The hooks a pull-request job runs, by moment, and where they were read. */
export interface PrLoopHooks {
  hooks: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;
  /** The commit they were read at. */
  base: string;
  /** A line for the log when none run because the base has no declaration, or could not be read. */
  note?: string;
}

/** The hooks of one `ci.hooks` block at `moment`. */
function at(hooks: OpWaveHooks | null | undefined, moment: OpWaveHookMoment): OpWaveHook[] {
  const [side, stage] = moment.split("-") as ["before" | "after", string];
  return ((hooks?.[side] as Record<string, OpWaveHook[] | undefined> | undefined)?.[stage]) ?? [];
}

/** The hooks `declaration` gives a job run in `cwd`: the top level's, then the member's. */
export function prLoopHooksOf(declaration: Pick<Declaration, "ci" | "members">, member: string | null): Partial<Record<OpWaveHookMoment, OpWaveHook[]>> {
  const own = member === null ? null : (declaration.members.find((m) => m.name === member)?.ciHooks ?? null);
  const out: Partial<Record<OpWaveHookMoment, OpWaveHook[]>> = {};
  for (const moment of PR_LOOP_HOOK_MOMENTS) {
    const list = [...at(declaration.ci?.hooks, moment), ...at(own, moment)];
    if (list.length > 0) out[moment] = list;
  }
  return out;
}

/** Whether the working tree's declaration names any `ci.hooks`. */
function checkoutNamesHooks(cwd: string): boolean {
  try {
    const located = locateWorkspace(cwd);
    const d = readDeclaration(located.tree);
    return Object.keys(prLoopHooksOf(d, memberAtCwd({ declaration: d, rootOnDisk: located.rootOnDisk }, cwd))).length > 0;
  } catch {
    return false;
  }
}

/**
 * The hooks a pull-request job in `cwd` runs, read from the workspace
 * declaration at `base`. Throws when the declaration at base cannot be read
 * and the working tree's names hooks.
 */
export function prLoopHooksAt(cwd: string, base: string): PrLoopHooks {
  let declaration: Declaration;
  let rootOnDisk: string;
  try {
    const located = locateWorkspace(cwd, base);
    declaration = readDeclaration(located.tree);
    rootOnDisk = located.rootOnDisk;
  } catch (err) {
    const missing = err instanceof WorkspaceReadError && (err.code === "declaration-missing" || err.code === "not-a-git-repository");
    const why = err instanceof Error ? err.message : String(err);
    if (checkoutNamesHooks(cwd)) {
      if (missing) return { hooks: {}, base, note: `ci.hooks: the base ${base.slice(0, 12)} has no workspace declaration, so the hooks this change declares do not run until it merges` };
      throw new Error(`ci.hooks are read from the workspace declaration at ${base.slice(0, 12)}, and it could not be read (${why}), so no hook can be trusted to run`);
    }
    return missing ? { hooks: {}, base } : { hooks: {}, base, note: `ci.hooks: the declaration at ${base.slice(0, 12)} could not be read (${why}); this checkout names no hooks, so none run` };
  }
  return { hooks: prLoopHooksOf(declaration, memberAtCwd({ declaration, rootOnDisk }, cwd)), base };
}

/** Where a pull-request job's hooks run, and what they are told. */
export interface PrHookPlace {
  /** The gate's op, `pr-<n>`: `{op}` and `CHANT_OP_WAVES`. */
  op: string;
  /** The environment: `{wave}`, `CHANT_WAVE` and `CHANT_ENV`. */
  env: string;
  stage: "plan" | "apply" | "record";
  /** The report directory, relative to `cwd`; the runs and plan files go under `<dir>/hooks`. */
  dir: string;
  cwd: string;
  exec?: OpWaveExec;
  log?: (line: string) => void;
}

/** What one moment's hooks came to on the pull-request path. */
export interface PrHooksRun {
  outcomes: PrHookOutcome[];
  failed?: string;
  holds: string[];
}

/**
 * Run the hooks of `moment` for `components` (#4288). `plans`, after the
 * plan, gives each component's members and step plans, written where a
 * `perRun` hook's `{plan}` points.
 */
export function runPrHooks(
  read: PrLoopHooks,
  moment: OpWaveHookMoment,
  place: PrHookPlace,
  components: readonly string[],
  planned?: { members: readonly PrMember[]; plans: Record<string, Record<string, unknown>> },
): PrHooksRun {
  const hooks = read.hooks[moment];
  if (!hooks || hooks.length === 0) return { outcomes: [], holds: [] };
  // Relative to cwd, as an Op waves job's paths are, whether --output was given relative or absolute.
  const dir = relative(place.cwd, resolve(place.cwd, place.dir, "hooks")) || ".";
  mkdirSync(join(place.cwd, dir, "plans"), { recursive: true });
  const runs: OpWaveHookRun[] = components.map((component) => {
    if (!planned) return { target: component, op: place.op };
    const plan = join(dir, "plans", `${component.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    const body = { component, members: planned.members.filter((m) => m.component === component), plans: planned.plans[component] ?? {} };
    writeFileSync(join(place.cwd, plan), JSON.stringify(body, null, 2) + "\n");
    return { target: component, op: place.op, plan };
  });
  const runsFile = join(dir, "runs.json");
  writeFileSync(join(place.cwd, runsFile), JSON.stringify({ version: 1, op: place.op, env: place.env, stage: place.stage, base: read.base, hook: moment, runs }, null, 2) + "\n");
  const ran: StageHooksRun = runStageHooks(moment, hooks, {
    name: place.op,
    op: place.op,
    wave: place.env,
    runs,
    runsFile,
    holdFile: join(dir, "hold.json"),
    env: { CHANT_ENV: place.env, CHANT_PR_STAGE: place.stage, CHANT_HOOKS_BASE: read.base },
    cwd: place.cwd,
    ...(place.exec ? { exec: place.exec } : {}),
    ...(place.log ? { log: place.log } : {}),
  });
  const outcomes = ran.outcomes.map((o): PrHookOutcome => ({
    moment: o.moment,
    name: o.name,
    ...(o.target ? { target: o.target } : {}),
    exit: o.exit,
    outcome: o.outcome === "failed" ? "failed" : o.outcome === "held" ? "held" : "passed",
  }));
  return { outcomes, ...(ran.failed ? { failed: ran.failed } : {}), holds: ran.holds };
}
