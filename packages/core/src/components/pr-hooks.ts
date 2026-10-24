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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { OpWaveHook, OpWaveHookMoment, OpWaveHooks } from "../op/op-waves";
import { PR_LOOP_HOOK_MOMENTS } from "../op/op-waves";
import { OP_WAVE_MAX_CHAINED_HOLDS, runStageHooks, type OpWaveExec, type OpWaveHookRun, type StageHooksRun } from "../op/op-waves-run";
import { readHoldRequest, spawnExec, type OpWaveHookOutcome, type OtherGateHold } from "../op/stage-hooks";
import { approveCommand } from "../op/gate";
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

/** How a gate a hook holds the job on stands (#4323). */
export interface PrHoldSettled {
  status: "approved" | "waiting";
  approvedBy?: string;
  approvedAt?: string;
}

/**
 * Settle a hold on another gate (#4323): an approval of `hold.request.gate`
 * at `hold.request.digest`, else a pending fact for it. The pull-request
 * jobs give this the ledger they decide their own gate by.
 */
export type PrHoldSettler = (hold: OtherGateHold) => Promise<PrHoldSettled>;

/** What one moment's hooks came to on the pull-request path. */
export interface PrHooksRun {
  outcomes: PrHookOutcome[];
  failed?: string;
  holds: string[];
}

/** The run's options: the gate's decision for `after-gate`, and who settles a hold on another gate. */
export interface PrHooksRunOptions {
  /** Added to every hook's environment: `after-gate` carries `CHANT_GATE_STATUS`, `CHANT_GATE_OP`, `CHANT_GATE` and `CHANT_GATE_DIGEST`. */
  env?: Record<string, string>;
  /** Without it a hold on another gate is a plain hold. */
  settle?: PrHoldSettler;
}

/**
 * Run the hooks of `moment` for `components` (#4288). `plans`, after the
 * plan, gives each component's members and step plans, written where a
 * `perRun` hook's `{plan}` points.
 */
export async function runPrHooks(
  read: PrLoopHooks,
  moment: OpWaveHookMoment,
  place: PrHookPlace,
  components: readonly string[],
  planned?: { members: readonly PrMember[]; plans: Record<string, Record<string, unknown>> },
  options: PrHooksRunOptions = {},
): Promise<PrHooksRun> {
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
    env: { CHANT_ENV: place.env, CHANT_PR_STAGE: place.stage, CHANT_HOOKS_BASE: read.base, ...options.env },
    keepOtherGates: options.settle !== undefined,
    cwd: place.cwd,
    ...(place.exec ? { exec: place.exec } : {}),
    ...(place.log ? { log: place.log } : {}),
  });
  const log = place.log ?? ((line: string) => console.error(line));
  const settled = ran.failed || !options.settle ? undefined : await settleHolds(ran.otherGates ?? [], options.settle, place, log);
  if (settled) {
    ran.outcomes.push(...settled.outcomes);
    if (settled.failed) ran.failed = settled.failed;
  }
  const outcomes = ran.outcomes.map((o): PrHookOutcome => ({
    moment: o.moment,
    name: o.name,
    ...(o.target ? { target: o.target } : {}),
    exit: o.exit,
    outcome: o.outcome === "failed" ? "failed" : o.outcome === "held" ? "held" : "passed",
  }));
  return { outcomes, ...(ran.failed ? { failed: ran.failed } : {}), holds: ran.holds };
}

/**
 * Settle each hook call that held the job on another gate (#4323), as an Op
 * waves job does (`runHooks` in op-waves-run.ts): once the gate is approved
 * the hook runs again with `CHANT_HOLD_APPROVED` (and `CHANT_HOLDS_APPROVED`,
 * the gates approved so far), and it may hold on a further gate, settled in
 * turn, up to {@link OP_WAVE_MAX_CHAINED_HOLDS}. A gate nobody approved fails
 * the stage, with the command that approves it.
 */
async function settleHolds(holds: readonly OtherGateHold[], settle: PrHoldSettler, place: PrHookPlace, log: (line: string) => void): Promise<{ outcomes: OpWaveHookOutcome[]; failed?: string }> {
  const outcomes: OpWaveHookOutcome[] = [];
  const exec = place.exec ?? spawnExec;
  for (const first of holds) {
    let hold = first;
    const approved: Array<{ op: string; gate: string; digest: string; approvedBy: string; approvedAt: string }> = [];
    for (;;) {
      const op = hold.request.op ?? place.op;
      const held = await settle(hold);
      if (held.status === "waiting") {
        return { outcomes, failed: `${hold.label} waits on ${op} / ${hold.request.gate}, which nobody approved at ${hold.request.digest}. Approve: ${approveCommand(op, hold.request.gate, undefined, hold.request.digest)}` };
      }
      const now = { op, gate: hold.request.gate, digest: hold.request.digest, approvedBy: held.approvedBy ?? "", approvedAt: held.approvedAt ?? "" };
      approved.push(now);
      const holdFile = join(place.cwd, hold.env.CHANT_HOLD!);
      rmSync(holdFile, { force: true });
      let code: number;
      try {
        code = exec(hold.argv, place.cwd, { ...hold.env, CHANT_HOLD_APPROVED: JSON.stringify(now), CHANT_HOLDS_APPROVED: JSON.stringify(approved) });
      } catch (err) {
        log(`${hold.label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
      const target = hold.target ? { target: hold.target } : {};
      if (code === 0) {
        outcomes.push({ moment: hold.moment, name: hold.name, ...target, exit: code, outcome: "passed" });
        log(`${hold.label}: ${now.approvedBy} approved ${op} / ${now.gate} at ${now.digest}, and the hook ran again and passed`);
        break;
      }
      const next = readHoldRequest(holdFile, log, hold.label);
      const nextOp = next ? (next.op ?? place.op) : "";
      const problem = !next
        ? `${hold.label} exited ${code} after ${now.approvedBy} approved ${now.gate}`
        : approved.some((a) => a.op === nextOp && a.gate === next.gate && a.digest === next.digest)
          ? `${hold.label} exited ${code} after ${now.approvedBy} approved ${now.gate}, and holds again on ${nextOp} / ${next.gate} at ${next.digest}, which is already approved`
          : approved.length >= OP_WAVE_MAX_CHAINED_HOLDS
            ? `${hold.label} held the job on ${approved.length} gates in turn and asks for one more; a hook call holds on at most ${OP_WAVE_MAX_CHAINED_HOLDS}`
            : undefined;
      if (problem) {
        outcomes.push({ moment: hold.moment, name: hold.name, ...target, exit: code, outcome: "failed" });
        log(problem);
        return { outcomes, failed: problem };
      }
      outcomes.push({ moment: hold.moment, name: hold.name, ...target, exit: code, outcome: "held" });
      hold = { ...hold, request: next! };
    }
  }
  return { outcomes };
}
