/**
 * The stage-hook runner (#4288): one moment's hooks, with the `targets`,
 * `perRun`, `onFailure` and argv filling a wave job uses. Its own module so
 * a product that runs hooks around its own stages (terragucci) bundles it
 * without the wave loop, the gate or the ledger. `op-waves-run.ts` runs
 * the same hooks inside a wave job.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { opWaveHookRuns, type CiHookMoment, type OpWaveHook } from "./op-waves";

/** What one moment's hooks came to, before any hold on another gate is settled. */
export interface HookListOutcome {
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed. */
  holds: string[];
  outcomes: OpWaveHookOutcome[];
  /** The hook calls that held the wave on another gate. */
  otherGates: OtherGateHold[];
}

/** Pending-fact keys chant writes itself, which a plans file's `pending` may not set (#3821). */
export const OP_WAVE_PENDING_RESERVED = [
  "version", "kind", "op", "gate", "timestamp", "expiresAt", "planDigest", "runId", "url", "resume",
  "environment", "origin", "neverOverMcp", "approval", "approvalMode", "answer", "wave", "heldBy",
] as const;

/** What a hook asks for when it holds a wave on another gate (#3821): it writes this to `CHANT_HOLD` and exits non-zero. */
export interface OpWaveHoldRequest {
  /** The op the gate is recorded under. Default: the spec's name. */
  op?: string;
  gate: string;
  /** The digest an approval binds. */
  digest: string;
  description?: string;
  /** Fields for the pending fact, as a plans file's `pending`. */
  pending?: Record<string, unknown>;
}

/** One hook's run (#3762). */
export interface OpWaveHookOutcome {
  moment: CiHookMoment;
  name: string;
  /** The run, for a `perRun` hook. */
  target?: string;
  exit: number;
  outcome: "passed" | "failed" | "held" | "skipped";
  /** Why the moment was skipped, for `skipped` (#3811). */
  reason?: string;
}

/** One run as a hook sees it (#3804). */
export interface OpWaveHookRun {
  target: string;
  op: string;
  /** The run's plan file, once planned. */
  plan?: string;
}

/** Runs one argv; returns its exit code. `env` is added to the job's environment. Injected so tests run no processes. */
export type OpWaveExec = (argv: string[], cwd: string, env?: Record<string, string>) => number;

export const spawnExec: OpWaveExec = (argv, cwd, env) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** {@link OpWaveExec} for {@link runStageHooksAsync} (#4334): the exit code comes back as a promise, so the event loop runs while a hook does. */
export type OpWaveAsyncExec = (argv: string[], cwd: string, env?: Record<string, string>) => Promise<number>;

/** {@link spawnExec} on `spawn`: it rejects when the command cannot start. */
export const spawnExecAsync: OpWaveAsyncExec = (argv, cwd, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

/** Fill one argv template. A placeholder whose value is not given is left as it is. */
export function opWaveArgv(
  template: readonly string[],
  values: { op: string; wave: string; target?: string; plan?: string; runs?: string; plans?: string },
): string[] {
  const pairs: Array<[string, string | undefined]> = [
    ["{op}", values.op],
    ["{target}", values.target],
    ["{wave}", values.wave],
    ["{plans}", values.plans],
    ["{plan}", values.plan],
    ["{runs}", values.runs],
  ];
  return template.map((part) => pairs.reduce((out, [key, value]) => (value === undefined ? out : out.replaceAll(key, value)), part));
}

/** A plans file's `pending` (#3821): an object whose keys chant does not write itself, `description` aside. Undefined when absent or empty. */
export function pendingFields(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: \`pending\` must be an object of fields for the pending fact`);
  const reserved = Object.keys(value).filter((key) => (OP_WAVE_PENDING_RESERVED as readonly string[]).includes(key));
  if (reserved.length > 0) throw new Error(`${where}: \`pending\` sets ${reserved.join(", ")}, which chant writes itself`);
  if ("description" in value && typeof (value as { description?: unknown }).description !== "string") throw new Error(`${where}: pending.description must be a string`);
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : undefined;
}

/** A hook call that held the wave on another gate (#3821), kept so it can run again once that gate is approved. */
export interface OtherGateHold {
  label: string;
  name: string;
  moment: CiHookMoment;
  target?: string;
  argv: string[];
  env: Record<string, string>;
  request: OpWaveHoldRequest;
}

/** Read the hold file a hook wrote (#3821), or undefined when it wrote none or one that names no gate and digest. */
export function readHoldRequest(path: string, log: (line: string) => void, label: string): OpWaveHoldRequest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, "utf-8")) as Partial<OpWaveHoldRequest>;
    if (typeof r.gate !== "string" || r.gate === "" || typeof r.digest !== "string" || r.digest === "") throw new Error("it names no gate and digest");
    if (r.op !== undefined && (typeof r.op !== "string" || r.op === "")) throw new Error("its op is not a name");
    return { gate: r.gate, digest: r.digest, ...(r.op ? { op: r.op } : {}), ...(typeof r.description === "string" ? { description: r.description } : {}), ...(r.pending ? { pending: pendingFields(r.pending, `the hold ${label} wrote`) ?? {} } : {}) };
  } catch (err) {
    log(`${label} wrote a hold file that cannot be read (${err instanceof Error ? err.message : String(err)}), so it holds the wave on its set digest`);
    return undefined;
  }
}

/** Where hooks run: the wave they belong to and the job's tools. */
export interface HookPlace {
  /** The spec's name and `op`. */
  name: string;
  op: string;
  waveName: string;
  k: number;
  cwd: string;
  exec: OpWaveExec;
  log: (line: string) => void;
  /** Where a hook writes a hold on another gate (`CHANT_HOLD`). Default: under the wave's directory. */
  holdPath?: string;
}

/** One hook call {@link hookListSteps} asks its driver to run. The driver sends back the exit code. */
interface HookCall {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * The hook list as steps (#4334): it yields each call and takes its exit
 * code back, so the sync and async runners share the targets, hold, outcome
 * and other-gate handling and differ only in how they wait for a call.
 */
function* hookListSteps(
  at: Omit<HookPlace, "exec">,
  moment: CiHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
  extraEnv: Record<string, string>,
): Generator<HookCall, HookListOutcome, number> {
  const out: HookListOutcome = { holds: [], outcomes: [], otherGates: [] };
  if (!hooks || hooks.length === 0) return out;
  const { name: specName, op, waveName, k, cwd, log } = at;
  // #3821: a hook that holds the wave on another gate names it in this file.
  const holdPath = at.holdPath ?? `.chant/op-waves/${specName}/wave-${k}/hold.json`;
  const env = { CHANT_OP_WAVES: specName, CHANT_WAVE: waveName, CHANT_WAVE_NUMBER: String(k), CHANT_HOOK: moment, CHANT_RUNS: runsPath, CHANT_HOLD: holdPath, ...extraEnv };
  for (const hook of hooks) {
    const name = hook.name ?? (hook.command.join(" ").length > 60 ? `${hook.command.join(" ").slice(0, 57)}...` : hook.command.join(" "));
    // #4288: a hook with `targets` is for the runs they match. Once for the wave, it runs when one matches or no run is known yet.
    const mine = opWaveHookRuns(hook, runs);
    if (hook.targets && (hook.perRun ? mine.length === 0 : mine.length === 0 && runs.length > 0)) {
      log(`${moment} hook ${name}: no run matches its targets (${hook.targets.join(", ")}), so it did not run`);
      continue;
    }
    const calls = hook.perRun
      ? mine.map((run) => ({
          target: run.target as string | undefined,
          argv: opWaveArgv(hook.command, { op: run.op, wave: waveName, target: run.target, runs: runsPath, ...(run.plan ? { plan: run.plan } : {}) }),
          env: { ...env, CHANT_TARGET: run.target, ...(run.plan ? { CHANT_PLAN: run.plan } : {}) } as Record<string, string>,
        }))
      : [{ target: undefined, argv: opWaveArgv(hook.command, { op, wave: waveName, runs: runsPath }), env: env as Record<string, string> }];
    for (const call of calls) {
      const label = `${moment} hook ${name}${call.target ? ` (${call.target})` : ""}`;
      rmSync(join(cwd, holdPath), { force: true });
      const code = yield { label, argv: call.argv, cwd, env: call.env };
      const base = { moment, name, ...(call.target ? { target: call.target } : {}), exit: code };
      if (code === 0) {
        out.outcomes.push({ ...base, outcome: "passed" });
        continue;
      }
      if (hook.onFailure === "approve") {
        out.outcomes.push({ ...base, outcome: "held" });
        const request = readHoldRequest(join(cwd, holdPath), log, label);
        if (request) {
          out.otherGates.push({ label, name, moment, ...(call.target ? { target: call.target } : {}), argv: call.argv, env: call.env, request });
          log(`${label} exited ${code} and holds wave ${k} (${waveName}) on gate ${request.op ?? specName} / ${request.gate}, digest ${request.digest}`);
          continue;
        }
        out.holds.push(label);
        log(`${label} exited ${code}, so wave ${k} (${waveName}) waits for an approval of its set digest`);
        continue;
      }
      out.outcomes.push({ ...base, outcome: "failed" });
      out.failed = `${label} exited ${code}`;
      log(out.failed);
      return out;
    }
  }
  return out;
}

/** The exit code a call that did not start counts as, after its error is logged. */
function didNotRun(call: HookCall, err: unknown, log: (line: string) => void): number {
  log(`${call.label} did not run: ${err instanceof Error ? err.message : String(err)}`);
  return 127;
}

/**
 * Run one moment's hooks, in order: each once for the wave, or once per run
 * for a `perRun` hook. A hook that fails stops the rest, unless its
 * `onFailure` is `approve`: then it holds the wave and the hooks after it run.
 */
export function runHookList(
  at: HookPlace,
  moment: CiHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
  extraEnv: Record<string, string> = {},
): HookListOutcome {
  const steps = hookListSteps(at, moment, hooks, runs, runsPath, extraEnv);
  let step = steps.next();
  while (!step.done) {
    const call = step.value;
    let code: number;
    try {
      code = at.exec(call.argv, call.cwd, call.env);
    } catch (err) {
      code = didNotRun(call, err, at.log);
    }
    step = steps.next(code);
  }
  return step.value;
}

/** {@link runHookList} with an exec that returns a promise (#4334). */
export async function runHookListAsync(
  at: Omit<HookPlace, "exec"> & { exec: OpWaveAsyncExec },
  moment: CiHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
  extraEnv: Record<string, string> = {},
): Promise<HookListOutcome> {
  const steps = hookListSteps(at, moment, hooks, runs, runsPath, extraEnv);
  let step = steps.next();
  while (!step.done) {
    const call = step.value;
    let code: number;
    try {
      code = await at.exec(call.argv, call.cwd, call.env);
    } catch (err) {
      code = didNotRun(call, err, at.log);
    }
    step = steps.next(code);
  }
  return step.value;
}

/** The options of {@link runStageHooks} (#4288). */
export interface RunStageHooksOptions {
  /** What the hooks belong to: `CHANT_OP_WAVES`, and the `{op}` of a hook that runs once. */
  name: string;
  op: string;
  /** `{wave}` and `CHANT_WAVE`. */
  wave: string;
  /** `CHANT_WAVE_NUMBER`. Default 0. */
  k?: number;
  /** The runs a `perRun` hook runs for and `targets` match against. */
  runs: readonly OpWaveHookRun[];
  /** `{runs}` and `CHANT_RUNS`, relative to `cwd`; the caller writes it. */
  runsFile: string;
  /** `CHANT_HOLD`, relative to `cwd`. */
  holdFile: string;
  /**
   * Give the hooks that held on another gate in {@link StageHooksRun.otherGates}
   * and leave them out of `holds` (#4323), for a caller that settles them.
   */
  keepOtherGates?: boolean;
  /** Added to every hook's environment. */
  env?: Record<string, string>;
  cwd?: string;
  exec?: OpWaveExec;
  log?: (line: string) => void;
}

/** What {@link runStageHooks} gave. */
export interface StageHooksRun {
  outcomes: OpWaveHookOutcome[];
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed. A hold on another gate counts as one here. */
  holds: string[];
  /** The hook calls that held on another gate, with `keepOtherGates` (#4323); absent otherwise. */
  otherGates?: OtherGateHold[];
}

/** {@link RunStageHooksOptions} for {@link runStageHooksAsync} (#4334). */
export interface RunStageHooksAsyncOptions extends Omit<RunStageHooksOptions, "exec"> {
  /** Default: {@link spawnExecAsync}. */
  exec?: OpWaveAsyncExec;
}

/** Where a stage runner's hooks run, without the exec. */
function stagePlace(options: Omit<RunStageHooksOptions, "exec">): Omit<HookPlace, "exec"> {
  return { name: options.name, op: options.op, waveName: options.wave, k: options.k ?? 0, cwd: options.cwd ?? process.cwd(), log: options.log ?? ((line: string) => console.error(line)), holdPath: options.holdFile };
}

/** A stage run's result: a hold on another gate counts as a plain hold. */
function stageRun(out: HookListOutcome, name: string, keep = false): StageHooksRun {
  if (keep) return { outcomes: out.outcomes, ...(out.failed ? { failed: out.failed } : {}), holds: out.holds, otherGates: out.otherGates };
  return { outcomes: out.outcomes, ...(out.failed ? { failed: out.failed } : {}), holds: [...out.holds, ...out.otherGates.map((g) => `${g.label} (on ${g.request.op ?? name} / ${g.request.gate})`)] };
}

/**
 * Run one moment's hooks outside an Op waves job (#4288): the pull-request
 * jobs, or a product's own stage, with the same `targets`, `perRun`,
 * `onFailure` and argv filling a wave job uses. A hook that holds on another
 * gate (`CHANT_HOLD`) is counted as a plain hold, unless `keepOtherGates` is
 * set (#4323): then it comes back in `otherGates` for the caller to settle.
 */
export function runStageHooks(moment: CiHookMoment, hooks: readonly OpWaveHook[] | undefined, options: RunStageHooksOptions): StageHooksRun {
  const place = { ...stagePlace(options), exec: options.exec ?? spawnExec };
  return stageRun(runHookList(place, moment, hooks, options.runs, options.runsFile, options.env), options.name, options.keepOtherGates);
}

/**
 * {@link runStageHooks} with an exec that returns a promise (#4334), so a
 * product can run several stages' hooks side by side. The hooks of one call
 * still run one after another. Give each concurrent call its own `holdFile`
 * and `runsFile`.
 */
export async function runStageHooksAsync(moment: CiHookMoment, hooks: readonly OpWaveHook[] | undefined, options: RunStageHooksAsyncOptions): Promise<StageHooksRun> {
  const place = { ...stagePlace(options), exec: options.exec ?? spawnExecAsync };
  return stageRun(await runHookListAsync(place, moment, hooks, options.runs, options.runsFile, options.env), options.name, options.keepOtherGates);
}
