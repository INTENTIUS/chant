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
 *
 * ## The wave answer (#4842)
 *
 * A hook's `wave`, when it has one, is called once per job after its `run`
 * was called for each of its runs, with all of them. It answers for the wave
 * as a whole, as a plans file does for a wave-level plan command:
 *
 * - `pending`: fields for the pending fact (a `description`, the commit it
 *   planned), under the plans file's rules (`pendingFields`).
 * - `members`: digest members that are no run, such as the wave's monthly
 *   cost from the product's own estimator.
 * - `holds`: reasons the wave waits for a person whatever its gate, one line
 *   each, as a held hook's.
 * - `overriders` and `overridersSource`: who may override a denial, in place
 *   of the overriders file at base. A run's own answer can name its own
 *   `overriders`, which count for that run in place of the wave's.
 * - `report`: the product's report of these plans. When the wave waits,
 *   chant stores it beside the pending fact, at
 *   `_gates/<op>/<gate>/<digest>.json`, once. When the plans moved after an
 *   approval, chant writes it and the report stored for the approved plans
 *   to `.chant/op-waves/<name>/wave-<k>/report/` (`current.json`,
 *   `approved.json`) and names them on the decision, for the job that
 *   explains the refusal.
 *
 * A `wave` that throws follows the hook's `onFailure`, as `run` does.
 */

import { isAbsolute } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import type { ChangeSetPart } from "../change-set";
import type { OpRunPolicyRow } from "./runtime";
import type { WaveMember } from "../wave-engine";
import { OP_WAVE_HOOK_FAILURES, opWaveHookRuns, type OpWaveHookFailure } from "./op-waves";
import { OP_WAVE_PENDING_RESERVED, type OpWaveHookOutcome } from "./stage-hooks";

/** The first chant whose after-plan hooks answer for the wave as a whole (`wave`), take a run's own `overriders`, and whose wave keeps the hook's report beside its pending fact (#4842). */
export const OP_WAVE_AFTER_PLAN_WAVE_FLOOR = NEXT_RELEASE;

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
  /** Who may override this run's denial (#4842), in place of the wave's overriders. */
  overriders?: string[];
}

/** A job's planned runs, as a hook's wave answer sees them (#4842). */
export interface OpWaveAfterPlanWave {
  spec: string;
  op: string;
  wave: number;
  waveName: string;
  job: OpWaveAfterPlanRun["job"];
  /** The runs the hook is for, in the wave's order, as its `run` saw each. */
  runs: OpWaveAfterPlanRun[];
  cwd: string;
}

/** What a hook adds to the wave as a whole (#4842). */
export interface OpWaveAfterPlanWaveResult {
  /** Fields for the wave's pending fact, as a plans file's `pending`. */
  pending?: Record<string, unknown>;
  /** Digest members that are no run, such as the wave's cost. */
  members?: WaveMember[];
  /** Why the wave waits for a person whatever its gate, a line each. */
  holds?: string[];
  /** Who may override a denial, in place of the overriders file at base. */
  overriders?: string[];
  /** Where those overriders come from, for a refusal: "policy.override in terragucci.yml". */
  overridersSource?: string;
  /** The product's report of these plans: stored beside the pending fact, and written for the respond job after the plans moved. */
  report?: string;
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
  /** Called once per job after `run` for each of its runs (#4842): what the hook adds to the wave. */
  wave?(planned: OpWaveAfterPlanWave): OpWaveAfterPlanWaveResult | void | Promise<OpWaveAfterPlanWaveResult | void>;
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
    if (hook.wave !== undefined && typeof hook.wave !== "function") problems.push(`${at}.wave must be a function`);
    if (hook.onFailure !== undefined && !OP_WAVE_HOOK_FAILURES.includes(hook.onFailure)) problems.push(`${at} has onFailure "${String(hook.onFailure)}"; use ${OP_WAVE_HOOK_FAILURES.join(" or ")}`);
    if (hook.targets !== undefined && (!Array.isArray(hook.targets) || hook.targets.length === 0 || !hook.targets.every((t) => typeof t === "string" && t !== ""))) problems.push(`${at}.targets must be a non-empty list of targets or patterns`);
  });
  return problems;
}

/** What is wrong with one answer of a hook, empty when nothing is. */
export function opWaveAfterPlanResultProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["the answer must be { policy?, files?, overriders? }"];
  const r = value as { policy?: unknown; files?: unknown; overriders?: unknown };
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
  if (r.overriders !== undefined && !principals(r.overriders)) problems.push("`overriders` must be a list of principals");
  return problems;
}

const principals = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === "string" && p.trim() !== "");

/** What is wrong with one wave answer (#4842), empty when nothing is. `targets` are the wave's runs, which no digest member may be named. */
export function opWaveAfterPlanWaveResultProblems(value: unknown, targets: readonly string[]): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["the wave answer must be { pending?, members?, holds?, overriders?, overridersSource?, report? }"];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (r.pending !== undefined) {
    const p = r.pending;
    if (p === null || typeof p !== "object" || Array.isArray(p)) problems.push("`pending` must be an object of fields for the pending fact");
    else {
      const reserved = Object.keys(p).filter((key) => (OP_WAVE_PENDING_RESERVED as readonly string[]).includes(key));
      if (reserved.length > 0) problems.push(`\`pending\` cannot set ${reserved.join(", ")}, which chant writes`);
      if ("description" in p && typeof (p as { description?: unknown }).description !== "string") problems.push("`pending.description` must be a string");
    }
  }
  if (r.overriders !== undefined && !principals(r.overriders)) problems.push("`overriders` must be a list of principals");
  if (r.overridersSource !== undefined && (typeof r.overridersSource !== "string" || r.overridersSource.trim() === "")) problems.push("`overridersSource` must say where the overriders come from");
  if (r.members !== undefined) {
    if (!Array.isArray(r.members)) problems.push("`members` must be a list of { member, planDigest }");
    else {
      const seen = new Set<string>();
      for (const m of r.members as Array<Partial<WaveMember> | null>) {
        if (!m || typeof m.member !== "string" || m.member === "" || typeof m.planDigest !== "string" || m.planDigest === "") {
          problems.push("each of `members` needs a member and a planDigest");
          continue;
        }
        if (targets.includes(m.member)) problems.push(`member ${m.member} is also a run's target; a digest member that is no run needs a name of its own`);
        else if (seen.has(m.member)) problems.push(`\`members\` names ${m.member} twice`);
        seen.add(m.member);
      }
    }
  }
  if (r.holds !== undefined && !(Array.isArray(r.holds) && r.holds.every((h) => typeof h === "string" && h.trim() !== ""))) problems.push("`holds` must be a list of reasons, each a line saying why the wave waits for a person");
  if (r.report !== undefined && typeof r.report !== "string") problems.push("`report` must be the report's text");
  return problems;
}

/** What one run's hooks came to. */
export interface OpWaveAfterPlanRunOutcome {
  /** The hooks' rows, in order. */
  policy: OpRunPolicyRow[];
  files: string[];
  /** Who may override its denial (#4842), when a hook named anyone: the last hook's list. */
  overriders?: string[];
}

/** What the hooks' wave answers came to (#4842), each hook's in order. */
export interface OpWaveAfterPlanWaveOutcome {
  pending?: Record<string, unknown>;
  members: WaveMember[];
  holds: string[];
  overriders?: string[];
  overridersSource?: string;
  report?: string;
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
  /** The wave answers (#4842). */
  wave: OpWaveAfterPlanWaveOutcome;
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
  const out: OpWaveAfterPlanOutcome = { holds: [], outcomes: [], runs: new Map(), wave: { members: [], holds: [] } };
  const targets = runs.map((r) => r.target);
  for (const hook of hooks) {
    const mine = opWaveHookRuns(hook, runs);
    for (const run of mine) {
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
        if (answer?.overriders) {
          const got = out.runs.get(run.target) ?? { policy: [], files: [] };
          got.overriders = [...new Set(answer.overriders)].sort();
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
    if (!hook.wave || mine.length === 0) continue;
    // #4842: the hook's answer for the wave, once its runs were each answered.
    const first = mine[0]!;
    const label = `after-plan hook ${hook.name} (wave ${first.wave})`;
    let problem: string | undefined;
    let answer: OpWaveAfterPlanWaveResult | void = undefined;
    try {
      answer = await hook.wave({ spec: first.spec, op: first.op, wave: first.wave, waveName: first.waveName, job: first.job, runs: [...mine], cwd: first.cwd });
      const wrong = opWaveAfterPlanWaveResultProblems(answer, targets);
      if (wrong.length > 0) problem = `${label} answered with ${wrong.join("; ")}`;
    } catch (err) {
      problem = `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const base = { moment: "after-plan" as const, name: hook.name };
    if (problem === undefined) {
      out.outcomes.push({ ...base, exit: 0, outcome: "passed" });
      if (answer) foldWaveAnswer(out.wave, answer);
      continue;
    }
    if (hook.onFailure === "approve") {
      out.outcomes.push({ ...base, exit: 1, outcome: "held" });
      out.holds.push(label);
      log(`${problem}, so wave ${first.wave} (${first.waveName}) waits for an approval of its set digest`);
      continue;
    }
    out.outcomes.push({ ...base, exit: 1, outcome: "failed" });
    out.failed = problem;
    log(problem);
    return out;
  }
  return out;
}

/** Fold one hook's wave answer into what the answers so far came to: fields and lists add up, a later list of overriders or report wins. */
function foldWaveAnswer(into: OpWaveAfterPlanWaveOutcome, answer: OpWaveAfterPlanWaveResult): void {
  if (answer.pending && Object.keys(answer.pending).length > 0) into.pending = { ...into.pending, ...answer.pending };
  for (const m of answer.members ?? []) if (!into.members.some((x) => x.member === m.member)) into.members.push({ member: m.member, planDigest: m.planDigest });
  for (const h of answer.holds ?? []) if (!into.holds.includes(h)) into.holds.push(h);
  if (answer.overriders) into.overriders = [...new Set(answer.overriders)].sort();
  if (answer.overridersSource) into.overridersSource = answer.overridersSource;
  if (answer.report !== undefined) into.report = answer.report;
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
