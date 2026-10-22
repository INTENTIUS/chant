/**
 * The stage-hook runner (#4288): one moment's hooks, with the `targets`,
 * `perRun`, `onFailure` and argv filling a wave job uses. Its own module so
 * a product that runs hooks around its own stages (terragucci) bundles it
 * without the wave loop, the gate or the ledger. `op-waves-run.ts` runs
 * the same hooks inside a wave job.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { opWaveHookRuns, type OpWaveHook, type OpWaveHookMoment } from "./op-waves";

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
  moment: OpWaveHookMoment;
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
  moment: OpWaveHookMoment;
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

/**
 * Run one moment's hooks, in order: each once for the wave, or once per run
 * for a `perRun` hook. A hook that fails stops the rest, unless its
 * `onFailure` is `approve`: then it holds the wave and the hooks after it run.
 */
export function runHookList(
  at: HookPlace,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
  extraEnv: Record<string, string> = {},
): HookListOutcome {
  const out: HookListOutcome = { holds: [], outcomes: [], otherGates: [] };
  if (!hooks || hooks.length === 0) return out;
  const { name: specName, op, waveName, k, cwd, exec, log } = at;
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
      let code: number;
      rmSync(join(cwd, holdPath), { force: true });
      try {
        code = exec(call.argv, cwd, call.env);
      } catch (err) {
        log(`${label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
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
}

/**
 * Run one moment's hooks outside an Op waves job (#4288): the pull-request
 * jobs, or a product's own stage, with the same `targets`, `perRun`,
 * `onFailure` and argv filling a wave job uses. A hook that holds on another
 * gate (`CHANT_HOLD`) is counted as a plain hold; settling that gate is the
 * caller's.
 */
export function runStageHooks(moment: OpWaveHookMoment, hooks: readonly OpWaveHook[] | undefined, options: RunStageHooksOptions): StageHooksRun {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  const place: HookPlace = { name: options.name, op: options.op, waveName: options.wave, k: options.k ?? 0, cwd, exec: options.exec ?? spawnExec, log, holdPath: options.holdFile };
  const out = runHookList(place, moment, hooks, options.runs, options.runsFile, options.env);
  return { outcomes: out.outcomes, ...(out.failed ? { failed: out.failed } : {}), holds: [...out.holds, ...out.otherGates.map((g) => `${g.label} (on ${g.request.op ?? options.name} / ${g.request.gate})`)] };
}
