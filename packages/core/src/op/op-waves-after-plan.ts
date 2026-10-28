/**
 * After-plan hooks in the wave job's process (#4614). A product that runs
 * chant in process (`runOpWave`, or a bin built on `runChantInProcess`)
 * passes `afterPlan` to build what it builds from each run's plan: its wave
 * report, its own policy rows, the plan files its other jobs read. Each hook
 * is called once per planned run, in the order the wave lists its runs,
 * after chant's wave holds ran and before the set digest and the gate. It
 * gets the run's plan digest, its `{plan}` file and, when the plan names
 * one, the engine's plan document (`{planJson}`), with the rows chant's
 * `holds.policy` gave the run.
 *
 * A hook may answer with policy rows and files. A `denied` row denies the
 * run as a policy denial does (an override of its rules then counts), a
 * `held` row holds the wave for a person, and every row and file goes on the
 * job's run record (`wave.plans`). A hook that throws follows its
 * `onFailure`: `fail` (the default) fails the wave before the gate, so
 * nothing is approved or applied; `approve` holds the wave for an approval
 * of its set digest, as a command hook's does.
 *
 * The spec's command hooks at `hooks.after.plan` keep running where they
 * ran: after the set digest, before the gate settles. A `perRun` one gets
 * `{planJson}`, `CHANT_PLAN_DIGEST` and `CHANT_PLAN_JSON` the same way.
 */

import { isAbsolute } from "node:path";
import type { ChangeSetPart } from "../change-set";
import type { OpRunPolicyRow } from "./runtime";
import { OP_WAVE_HOOK_FAILURES, opWaveHookRuns, type OpWaveHookFailure } from "./op-waves";
import type { OpWaveHookOutcome } from "./stage-hooks";

/** One planned run, as an after-plan hook in the job's process sees it (#4614). */
export interface OpWaveAfterPlanRun {
  /** The spec's name and `op`. */
  spec: string;
  op: string;
  /** The wave, 1-based, and its name. */
  wave: number;
  waveName: string;
  /** The job planning it: `wave` for a whole wave, `decide` for a wide wave's deciding job, `share` or `group` for its apply jobs. */
  job: "wave" | "decide" | "share" | "group";
  target: string;
  /** The run's own op. */
  runOp: string;
  planDigest: string;
  /** The run's plan file, relative to the job's directory: `{plan}`. */
  plan: string;
  /** The engine's plan document, when the plan names one (`artifact.planJson`): `{planJson}`. */
  planJson?: string;
  /** The capability's artifact, for a run planned through a `step`. */
  artifact?: unknown;
  /** The run's change-set part, when its plan gave one. */
  changeSet?: ChangeSetPart;
  empty: boolean;
  destructive: boolean;
  /** The rows chant's `holds.policy` gave the run (source `ci.policy`), empty when no policy ran. */
  policy: OpRunPolicyRow[];
  /** The job's directory. */
  cwd: string;
}

/** What an after-plan hook adds to its run (#4614). */
export interface OpWaveAfterPlanResult {
  /** The product's own policy rows. `denied` denies the run and `held` holds the wave. */
  policy?: OpRunPolicyRow[];
  /** Files the hook wrote for the run, relative to the job's directory. */
  files?: string[];
}

/** An after-plan hook in the wave job's process (#4614). */
export interface OpWaveAfterPlanHook {
  /** The hook's name in the log, the result's hooks and the run record. */
  name: string;
  /** Default `fail`. */
  onFailure?: OpWaveHookFailure;
  /** The runs it is for, as a command hook's `targets`. Default: every run. */
  targets?: string[];
  run(planned: OpWaveAfterPlanRun): OpWaveAfterPlanResult | void | Promise<OpWaveAfterPlanResult | void>;
}

const ROW_RESULTS: ReadonlyArray<OpRunPolicyRow["result"]> = ["passed", "warned", "denied", "held"];

/** What is wrong with `afterPlan`, empty when nothing is. */
export function opWaveAfterPlanProblems(hooks: unknown): string[] {
  if (hooks === undefined) return [];
  const list = Array.isArray(hooks) ? hooks : [hooks];
  const problems: string[] = [];
  list.forEach((h: unknown, i) => {
    const at = `afterPlan[${i}]`;
    const hook = h as Partial<OpWaveAfterPlanHook> | null;
    if (!hook || typeof hook !== "object") return void problems.push(`${at} must be { name, run, onFailure?, targets? }`);
    if (typeof hook.name !== "string" || hook.name.trim() === "") problems.push(`${at} needs a name`);
    if (typeof hook.run !== "function") problems.push(`${at} needs a run function`);
    if (hook.onFailure !== undefined && !OP_WAVE_HOOK_FAILURES.includes(hook.onFailure)) problems.push(`${at} has onFailure "${String(hook.onFailure)}"; use ${OP_WAVE_HOOK_FAILURES.join(" or ")}`);
    if (hook.targets !== undefined && (!Array.isArray(hook.targets) || hook.targets.length === 0 || !hook.targets.every((t) => typeof t === "string" && t !== ""))) problems.push(`${at}.targets must be a non-empty list of targets or patterns`);
  });
  return problems;
}

/** What is wrong with one answer of a hook, empty when nothing is. */
export function opWaveAfterPlanResultProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["the answer must be { policy?, files? }"];
  const r = value as { policy?: unknown; files?: unknown };
  const problems: string[] = [];
  if (r.policy !== undefined) {
    if (!Array.isArray(r.policy)) problems.push("`policy` must be a list of rows");
    else r.policy.forEach((row: unknown, i) => {
      const x = row as Partial<OpRunPolicyRow> | null;
      if (!x || typeof x !== "object") return void problems.push(`policy[${i}] must be { source, result, rules, reason? }`);
      if (typeof x.source !== "string" || x.source === "") problems.push(`policy[${i}] needs a source`);
      if (!ROW_RESULTS.includes(x.result as OpRunPolicyRow["result"])) problems.push(`policy[${i}] has result ${JSON.stringify(x.result)}; use ${ROW_RESULTS.join(", ")}`);
      if (!Array.isArray(x.rules) || !x.rules.every((t) => typeof t === "string" && t.trim() !== "")) problems.push(`policy[${i}].rules must be a list of rule ids`);
      else if ((x.result === "denied" || x.result === "held") && x.rules.length === 0) problems.push(`policy[${i}] is ${x.result} and names no rule, which an override or an approval would have to name`);
      if (x.reason !== undefined && typeof x.reason !== "string") problems.push(`policy[${i}].reason must be a string`);
    });
  }
  if (r.files !== undefined && (!Array.isArray(r.files) || !r.files.every((f) => typeof f === "string" && f !== "" && !isAbsolute(f) && !f.split("/").includes("..")))) {
    problems.push("`files` must be paths inside the job's directory, relative to it");
  }
  return problems;
}

/** What one run's hooks came to. */
export interface OpWaveAfterPlanRunOutcome {
  /** The hooks' rows, in order. */
  policy: OpRunPolicyRow[];
  files: string[];
}

/** What the after-plan hooks in the job's process came to (#4614). */
export interface OpWaveAfterPlanOutcome {
  /** Set when a hook with `onFailure: fail` failed; nothing after it ran. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed, each with its run. */
  holds: string[];
  outcomes: OpWaveHookOutcome[];
  /** Each run's rows and files, by target, for the runs a hook answered. */
  runs: Map<string, OpWaveAfterPlanRunOutcome>;
}

/**
 * Call each hook once per run it is for, hook by hook, each over the runs
 * in the wave's order (#4614). A hook that throws, or answers with a shape
 * chant cannot read, failed: under `fail` nothing after it runs, under
 * `approve` it holds the wave and the rest go on.
 */
export async function runOpWaveAfterPlanHooks(
  hooks: readonly OpWaveAfterPlanHook[],
  runs: readonly OpWaveAfterPlanRun[],
  log: (line: string) => void,
): Promise<OpWaveAfterPlanOutcome> {
  const out: OpWaveAfterPlanOutcome = { holds: [], outcomes: [], runs: new Map() };
  for (const hook of hooks) {
    for (const run of opWaveHookRuns(hook, runs)) {
      const label = `after-plan hook ${hook.name} (${run.target})`;
      let problem: string | undefined;
      let answer: OpWaveAfterPlanResult | void = undefined;
      try {
        answer = await hook.run(run);
        const wrong = opWaveAfterPlanResultProblems(answer);
        if (wrong.length > 0) problem = `${label} answered with ${wrong.join("; ")}`;
      } catch (err) {
        problem = `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const base = { moment: "after-plan" as const, name: hook.name, target: run.target };
      if (problem === undefined) {
        out.outcomes.push({ ...base, exit: 0, outcome: "passed" });
        if (answer && (answer.policy?.length || answer.files?.length)) {
          const got = out.runs.get(run.target) ?? { policy: [], files: [] };
          for (const row of answer.policy ?? []) got.policy.push({ source: row.source, result: row.result, rules: [...new Set(row.rules)].sort(), ...(row.reason ? { reason: row.reason } : {}) });
          for (const f of answer.files ?? []) if (!got.files.includes(f)) got.files.push(f);
          out.runs.set(run.target, got);
        }
        continue;
      }
      if (hook.onFailure === "approve") {
        out.outcomes.push({ ...base, exit: 1, outcome: "held" });
        out.holds.push(label);
        log(`${problem}, so wave ${run.wave} (${run.waveName}) waits for an approval of its set digest`);
        continue;
      }
      out.outcomes.push({ ...base, exit: 1, outcome: "failed" });
      out.failed = problem;
      log(problem);
      return out;
    }
  }
  return out;
}

/** Fold policy rows into a run's denial and hold: the rules of every `denied` row, and of every `held` row. */
export function foldPolicyRows(
  rows: readonly OpRunPolicyRow[],
  now: { denied?: { rules: string[]; reason?: string }; held?: { rules: string[]; reason?: string } },
): { denied?: { rules: string[]; reason?: string }; held?: { rules: string[]; reason?: string } } {
  const fold = (kind: "denied" | "held", was?: { rules: string[]; reason?: string }) => {
    const mine = rows.filter((r) => r.result === kind);
    if (mine.length === 0) return was;
    const rules = [...new Set([...(was?.rules ?? []), ...mine.flatMap((r) => r.rules)])].sort();
    const reason = [was?.reason, ...mine.map((r) => r.reason)].filter((x): x is string => !!x).join("; ");
    return { rules, ...(reason ? { reason } : {}) };
  };
  const denied = fold("denied", now.denied);
  const held = fold("held", now.held);
  return { ...(denied ? { denied } : {}), ...(held ? { held } : {}) };
}

/**
 * What a product's bin hands `chant run wave` when it runs chant in process
 * (#4614): `runChantInProcess(["run", "wave", ...], words, { wave })`. The
 * job then calls the product's after-plan hooks, and plans and applies a
 * `step` through the product's own capability registry when it gives one.
 */
export interface ProductWaveHook {
  afterPlan?: OpWaveAfterPlanHook | readonly OpWaveAfterPlanHook[];
  capabilities?: import("../components/capability").CapabilityRegistry;
  /** How the spec's command hooks run, when they call back into the product's process (`RunOpWaveOptions.hookExec`). */
  hookExec?: import("./stage-hooks").OpWaveAsyncExec;
}

let activeWave: ProductWaveHook | undefined;

/** The product's wave hook while a command it runs in process runs, else undefined. */
export function activeProductWaveHook(): ProductWaveHook | undefined {
  return activeWave;
}

/** Run `fn` with `hook` active, and put the earlier one back after it settles. */
export async function withProductWaveHook<T>(hook: ProductWaveHook | undefined, fn: () => Promise<T>): Promise<T> {
  if (!hook) return fn();
  const was = activeWave;
  activeWave = hook;
  try {
    return await fn();
  } finally {
    activeWave = was;
  }
}
