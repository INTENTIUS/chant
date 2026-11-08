/**
 * Run hooks in the wave job's process (#4842): what a product does around
 * each run of a wave with a `step`, beside its after-plan hooks
 * (`./op-waves-after-plan.ts`). A product that runs chant in process
 * (`runOpWave`, or a bin built on `runChantInProcess`) passes `runHooks`.
 *
 * - `beforePlan` is called before the run's step plans. Its answer can give
 *   the run an `env`, the environment variables its engine plans and
 *   applies with over the job's (a role's credentials, values read from a
 *   secret store), and an `afterInit` check, which the capability calls
 *   once its engine has initialised the run and before the plan runs any of
 *   the run's code (a module and provider source check). `refuse` stops the
 *   run before its engine starts: the wave then plans nothing more and
 *   applies nothing, as a run whose plan failed.
 * - `beforeApply` is called before the run's step applies the plan the gate
 *   decided. A hook that throws fails the run, and nothing of it applies.
 * - `afterApply` is called once the step's apply came back, whatever the
 *   outcome, with the capability's output when it applied. Its `files` go
 *   on the run record beside the run's apply. A hook that throws after an
 *   apply fails the run, as an after-apply command hook does.
 *
 * Several hooks run in the order given. Their `env` values are laid over one
 * another, the later winning. `targets` limits a hook to the runs it
 * matches, as for a command hook. A wave whose spec names no `step` has no
 * plan or apply of chant's to run them around, so they are not called.
 */

import { isAbsolute } from "node:path";
import { opWaveHookRuns } from "./op-waves";

/** The first chant that runs a product's `runHooks` around each run of a wave with a `step` (#4842), and hands its `env` and `afterInit` to the capability (`DeployContext.processEnv`, `DeployContext.afterInit`). */
export const OP_WAVE_RUN_HOOKS_FLOOR = "0.124.79";

/** One run of a wave, as a run hook sees it (#4842). */
export interface OpWaveRunHookRun {
  /** The spec's name and `op`. */
  spec: string;
  op: string;
  wave: number;
  waveName: string;
  /** The job: `wave` for a whole wave, `decide` for a wide wave's deciding job, `share` or `group` for its apply jobs. */
  job: "wave" | "decide" | "share" | "group";
  target: string;
  /** The run's own op. */
  runOp: string;
  /** The job's directory. */
  cwd: string;
}

/** A planned run, as `beforeApply` and `afterApply` see it. */
export interface OpWaveRunHookPlanned extends OpWaveRunHookRun {
  planDigest: string;
  /** The run's plan file, relative to the job's directory: `{plan}`. */
  plan: string;
  /** The capability's artifact. */
  artifact?: unknown;
}

/** An applied run, as `afterApply` sees it. */
export interface OpWaveRunHookApplied extends OpWaveRunHookPlanned {
  outcome: "applied" | "moved" | "failed";
  /** The capability's output, when it applied. */
  output?: unknown;
  /** Why it did not apply. */
  reason?: string;
}

/** What `beforePlan` gives a run. */
export interface OpWaveBeforePlanResult {
  /** Environment variables the run's engine plans and applies with, over the job's. */
  env?: Record<string, string>;
  /** A check the capability calls after its engine's init and before its plan. It throws to stop the run. */
  afterInit?: () => void | Promise<void>;
  /** Why the run is not planned at all. */
  refuse?: string;
}

/** What `afterApply` adds to a run. */
export interface OpWaveAfterApplyResult {
  /** Files the hook wrote for the run, relative to the job's directory. They go on the run record. */
  files?: string[];
}

/** Hooks around each run of a wave with a `step`, in the job's process (#4842). */
export interface OpWaveRunHooks {
  /** The hook's name in the log. */
  name: string;
  /** The runs it is for, as a command hook's `targets`. Default: every run. */
  targets?: string[];
  beforePlan?(run: OpWaveRunHookRun): OpWaveBeforePlanResult | void | Promise<OpWaveBeforePlanResult | void>;
  beforeApply?(run: OpWaveRunHookPlanned): void | Promise<void>;
  afterApply?(run: OpWaveRunHookApplied): OpWaveAfterApplyResult | void | Promise<OpWaveAfterApplyResult | void>;
}

/** What is wrong with `runHooks`, empty when nothing is. */
export function opWaveRunHooksProblems(hooks: unknown): string[] {
  if (hooks === undefined) return [];
  const list = Array.isArray(hooks) ? hooks : [hooks];
  const problems: string[] = [];
  list.forEach((h: unknown, i) => {
    const at = `runHooks[${i}]`;
    const hook = h as Partial<Record<keyof OpWaveRunHooks, unknown>> | null;
    if (!hook || typeof hook !== "object") return void problems.push(`${at} must be { name, beforePlan?, beforeApply?, afterApply?, targets? }`);
    if (typeof hook.name !== "string" || hook.name.trim() === "") problems.push(`${at} needs a name`);
    const moments = (["beforePlan", "beforeApply", "afterApply"] as const).filter((m) => hook[m] !== undefined);
    if (moments.length === 0) problems.push(`${at} gives none of beforePlan, beforeApply and afterApply`);
    for (const m of moments) if (typeof hook[m] !== "function") problems.push(`${at}.${m} must be a function`);
    if (hook.targets !== undefined && (!Array.isArray(hook.targets) || hook.targets.length === 0 || !hook.targets.every((t) => typeof t === "string" && t !== ""))) problems.push(`${at}.targets must be a non-empty list of targets or patterns`);
  });
  return problems;
}

/** The hooks as a list. */
export function opWaveRunHookList(given: OpWaveRunHooks | readonly OpWaveRunHooks[] | undefined): readonly OpWaveRunHooks[] {
  if (given === undefined) return [];
  return Array.isArray(given) ? (given as readonly OpWaveRunHooks[]) : [given as OpWaveRunHooks];
}

const forRun = <T extends { target: string }>(hook: OpWaveRunHooks, run: T): boolean => opWaveHookRuns(hook, [run]).length > 0;

/** What the `beforePlan` hooks gave one run. */
export type OpWaveBeforePlanOutcome = { refused: string } | { env?: Record<string, string>; afterInit?: () => Promise<void> };

/** Call each hook's `beforePlan` for `run`, in order. A hook that throws or refuses stops the rest and refuses the run. */
export async function runOpWaveBeforePlan(hooks: readonly OpWaveRunHooks[], run: OpWaveRunHookRun): Promise<OpWaveBeforePlanOutcome> {
  let env: Record<string, string> | undefined;
  const checks: Array<() => void | Promise<void>> = [];
  for (const hook of hooks) {
    if (!hook.beforePlan || !forRun(hook, run)) continue;
    let answer: OpWaveBeforePlanResult | void;
    try {
      answer = await hook.beforePlan(run);
    } catch (err) {
      return { refused: `the before-plan hook ${hook.name} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!answer) continue;
    if (answer.refuse !== undefined) return { refused: `the before-plan hook ${hook.name} refused it: ${answer.refuse}` };
    if (answer.env !== undefined) {
      const bad = typeof answer.env !== "object" || answer.env === null || Array.isArray(answer.env) || !Object.values(answer.env).every((v) => typeof v === "string");
      if (bad) return { refused: `the before-plan hook ${hook.name} answered with an env that is not a map of names to strings` };
      env = { ...env, ...answer.env };
    }
    if (answer.afterInit !== undefined) {
      if (typeof answer.afterInit !== "function") return { refused: `the before-plan hook ${hook.name} answered with an afterInit that is not a function` };
      const name = hook.name;
      const check = answer.afterInit;
      checks.push(async () => {
        try {
          await check();
        } catch (err) {
          throw new Error(`the check after init of ${name} refused it: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
  }
  return {
    ...(env ? { env } : {}),
    ...(checks.length > 0 ? { afterInit: async () => { for (const c of checks) await c(); } } : {}),
  };
}

/** Call each hook's `beforeApply` for `run`. Returns why the run must not apply, or undefined. */
export async function runOpWaveBeforeApply(hooks: readonly OpWaveRunHooks[], run: OpWaveRunHookPlanned): Promise<string | undefined> {
  for (const hook of hooks) {
    if (!hook.beforeApply || !forRun(hook, run)) continue;
    try {
      await hook.beforeApply(run);
    } catch (err) {
      return `the before-apply hook ${hook.name} failed, so nothing of it was applied: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

/** Call each hook's `afterApply` for `run`: the files they wrote, and why the run fails when one threw or answered badly. */
export async function runOpWaveAfterApply(hooks: readonly OpWaveRunHooks[], run: OpWaveRunHookApplied): Promise<{ files: string[]; failed?: string }> {
  const files: string[] = [];
  for (const hook of hooks) {
    if (!hook.afterApply || !forRun(hook, run)) continue;
    let answer: OpWaveAfterApplyResult | void;
    try {
      answer = await hook.afterApply(run);
    } catch (err) {
      return { files, failed: `the after-apply hook ${hook.name} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const given = answer?.files;
    if (given === undefined) continue;
    if (!Array.isArray(given) || !given.every((f) => typeof f === "string" && f !== "" && !isAbsolute(f) && !f.split("/").includes(".."))) {
      return { files, failed: `the after-apply hook ${hook.name} answered with files that are not paths inside the job's directory` };
    }
    for (const f of given) if (!files.includes(f)) files.push(f);
  }
  return { files };
}
