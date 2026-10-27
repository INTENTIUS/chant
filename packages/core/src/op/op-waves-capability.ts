/**
 * Op waves through capabilities (#4545): a wave whose spec names a `step`
 * plans and applies each run through a capability (`terraform-apply`,
 * `pulumi-up`, any kind a lexicon's plugin contributes) in the job's own
 * process, in place of a `plan` and an `apply` command. The gate, the
 * approval, the spend, the hooks, the shares and the run record are the ones
 * every op wave has; only who plans and who applies changes.
 *
 * ## The step
 *
 * `step` is `{ kind, ...input }`, the same shape a component's deploy step
 * has. Each string in the input has `{target}`, `{op}` and `{wave}` filled
 * per run, and a run's own `input` is laid over it, so one step covers every
 * root of a wave and a run adds what is its own (vars, reads):
 *
 * ```json
 * { "step": { "kind": "terraform-apply", "root": "{target}", "lockTimeout": "5m" },
 *   "waves": [{ "name": "dev", "runs": [{ "target": "network" }, { "target": "app", "input": { "vars": { "size": "s" } } }] }] }
 * ```
 *
 * - Plan: `capability.plan` per run. The run's member digest is the plan's
 *   `planDigest`; `empty` and `destructive` come from its change-set part
 *   (no entry but `no-op` and `read`; a `delete` or `replace`), and a plan
 *   whose `destructive` names a class of the engine's own is destructive
 *   too (#4569, the sql lexicon's `sql-migrate`). A member
 *   whose part has holes and no artifact cannot apply, so planning fails
 *   with the holes' reasons. The parts compose into the wave's change-set
 *   document, which the pending fact cites (#4551).
 * - Apply: `capability.run` with the plan's artifact in `DeployContext.plans`,
 *   so the run applies the plan the gate decided and nothing else. A run the
 *   capability refuses as moved (`isPlanMovedError`) applied nothing and the
 *   job exits 4, the table's moved code (#4553); any other error fails it.
 *
 * The registry is the project's (`fanOutRegistry`, the one `chant run
 * --components` builds), loaded once per job behind a dynamic import, so the
 * wave-job runtime bundle stays without the config loader. A product that
 * runs chant in process passes its own (`RunOpWaveOptions.capabilities`).
 *
 * ## Holds (#4545)
 *
 * `holds` is a wave hold any product switches on, read at base with the
 * policy, so a change cannot drop the hold its own wave is judged by:
 *
 * - `policy: true` runs the workspace's `ci.policy` (read at base, as the
 *   pull-request path reads it, `../components/pr-policy.ts`) over each
 *   run's change-set part. Its deny rules deny the run (an override then
 *   counts, `../override-gate.ts`), its hold rules hold it for a person, and
 *   a policy that cannot run fails the wave.
 * - `cost` runs an estimator per run and sums the monthly change. Over
 *   `approveAbove` the wave waits for a person whatever its gate says, and
 *   the cost is a member of the set digest, so an approval at one cost does
 *   not apply at another. A run the estimator cannot price holds the wave
 *   too. The terraform lexicon's preset is `terraformCostHold` (infracost).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capability, CapabilityPlan, CapabilityRegistry, DeployContext } from "../components/capability";
import { isPlanMovedError } from "../components/capability";
import type { CapabilityTraceFacts } from "../otlp";
import { composeChangeSet, type ChangeSetDocument, type ChangeSetPart } from "../change-set";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { GatePolicyExec, GatePolicyRun } from "../gate-policy";
import type { WaveMember } from "../wave-engine";
import type { OpWave, OpWaveRun, OpWavesSpec } from "./op-waves";
import { resolvePlannedLock, type LockGrain, type PlannedLock } from "../lifecycle/lock-rows";

/** A capability step a wave plans and applies each run through (#4545): `{ kind, ...input }`. */
export interface OpWaveStep {
  /** The capability's kind, such as `terraform-apply` or `pulumi-up`. */
  kind: string;
  /** The step's input. Each string has `{target}`, `{op}` and `{wave}` filled per run. */
  [field: string]: unknown;
}

/** The estimate's shape a cost hold reads. */
export const OP_WAVE_COST_FORMATS = ["infracost", "chant"] as const;
export type OpWaveCostFormat = (typeof OP_WAVE_COST_FORMATS)[number];

/** A cost hold (#4545): an estimator per run, and the monthly change over which the wave waits. */
export interface OpWaveCostHold {
  /**
   * Argv, run once per run that changes something. `{target}` and `{plan}`
   * (the run's plan file, as hooks get it) are filled in, and `{planJson}`
   * with the engine's plan document when the capability's plan names one
   * (`artifact.planJson`). It prints the estimate on standard output.
   */
  command: string[];
  /** The monthly change, summed over the wave's runs, above which the wave waits for a person. */
  approveAbove: number;
  /** `infracost`: `infracost breakdown --format json`'s document. `chant`: `{ "monthlyDelta": <number>, "currency"?: "<code>" }`. Default `infracost`. */
  format?: OpWaveCostFormat;
  /** The currency `approveAbove` is in, for the log and the digest. Default the estimate's, else `USD`. */
  currency?: string;
}

/** Holds a wave runs over its plans (#4545), read at base. */
export interface OpWaveHolds {
  /** Run the workspace's `ci.policy` at base over each run's change set: deny rules deny the run, hold rules hold it. */
  policy?: boolean;
  /** Price each run and hold the wave over a monthly change. */
  cost?: OpWaveCostHold;
}

/** The digest member a cost hold adds (#4545): no run has this name. */
export const OP_WAVE_COST_MEMBER = "(monthly cost)";

/** What is wrong with a spec's `step`, empty when nothing is. */
export function opWaveStepProblems(spec: Pick<OpWavesSpec, "step" | "plan" | "apply" | "planWave" | "applyWave" | "hooks" | "waves">): string[] {
  const step = spec.step as unknown;
  if (step === undefined) return [];
  if (step === null || typeof step !== "object" || Array.isArray(step)) return ["`step` must be { \"kind\": \"<capability>\", ...input }"];
  const problems: string[] = [];
  const kind = (step as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind.trim() === "") problems.push("`step.kind` must name a capability, such as \"terraform-apply\"");
  for (const key of ["plan", "apply", "planWave", "applyWave"] as const) {
    if (spec[key] !== undefined) problems.push(`\`step\` and \`${key}\` are both set; a wave plans and applies through its capability or through commands, so give one`);
  }
  if (spec.hooks?.apply?.runBy === "apply") problems.push("`hooks.apply.runBy: \"apply\"` hands the apply-stage hooks to an apply command, and a `step` has none; leave runBy as chant");
  for (const wave of spec.waves) {
    if (wave.discover) problems.push(`wave "${wave.name}" discovers its runs, which only \`planWave\` can report; a \`step\` plans the runs the spec lists`);
    if (wave.hooks?.apply?.runBy === "apply") problems.push(`wave "${wave.name}" hands its apply-stage hooks to an apply command, and a \`step\` has none`);
    for (const run of wave.runs ?? []) {
      const input = run.input as unknown;
      if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) problems.push(`wave "${wave.name}" run "${run.target}": \`input\` must be an object laid over the step's input`);
      if (input && typeof input === "object" && "kind" in input) problems.push(`wave "${wave.name}" run "${run.target}": \`input\` cannot change the step's kind`);
    }
  }
  return problems;
}

/** What is wrong with a spec's `holds`, empty when nothing is. */
export function opWaveHoldsProblems(holds: unknown): string[] {
  if (holds === undefined) return [];
  if (holds === null || typeof holds !== "object" || Array.isArray(holds)) return ["`holds` must be { \"policy\"?: true, \"cost\"?: {...} }"];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(holds as Record<string, unknown>)) {
    if (key === "policy") {
      if (typeof value !== "boolean") problems.push("`holds.policy` must be true or false");
    } else if (key === "cost") {
      problems.push(...costHoldProblems(value));
    } else problems.push(`\`holds.${key}\` is not a setting; the ones there are holds.policy and holds.cost`);
  }
  return problems;
}

function costHoldProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["`holds.cost` must be { \"command\": [...], \"approveAbove\": <number>, \"format\"?, \"currency\"? }"];
  const c = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!Array.isArray(c.command) || c.command.length === 0 || !c.command.every((a) => typeof a === "string" && a !== "")) problems.push("`holds.cost.command` must be argv, a non-empty list of strings");
  if (typeof c.approveAbove !== "number" || !Number.isFinite(c.approveAbove) || c.approveAbove < 0) problems.push("`holds.cost.approveAbove` must be a monthly amount of 0 or more");
  if (c.format !== undefined && !(OP_WAVE_COST_FORMATS as readonly unknown[]).includes(c.format)) problems.push(`\`holds.cost.format\` must be ${OP_WAVE_COST_FORMATS.join(" or ")}`);
  if (c.currency !== undefined && (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))) problems.push("`holds.cost.currency` must be a three-letter currency code, such as \"USD\"");
  for (const key of Object.keys(c)) if (!["command", "approveAbove", "format", "currency"].includes(key)) problems.push(`\`holds.cost.${key}\` is not a setting`);
  return problems;
}

/**
 * The holds wave rules take (#4545): the spec's at base, else the change's
 * when the base has none. `policy` is on when either one sets it, so a
 * change can add the hold and never drop it. Undefined when neither sets any.
 */
export function opWaveHoldsAt(atBase: OpWaveHolds | undefined, change: OpWaveHolds | undefined): OpWaveHolds | undefined {
  const policy = atBase?.policy === true || change?.policy === true;
  const cost = atBase !== undefined ? atBase.cost : change?.cost;
  if (!policy && !cost) return undefined;
  return { ...(policy ? { policy: true } : {}), ...(cost ? { cost } : {}) };
}

/** Fill `{target}`, `{op}` and `{wave}` in every string of `value`. */
function fill(value: unknown, vars: { target: string; op: string; wave: string }): unknown {
  if (typeof value === "string") return value.replaceAll("{target}", vars.target).replaceAll("{op}", vars.op).replaceAll("{wave}", vars.wave);
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** The input a run's step gets (#4545): the spec's step with the run's values filled in, and the run's own `input` over it. */
export function opWaveStepInput(spec: Pick<OpWavesSpec, "op" | "step">, wave: Pick<OpWave, "name">, run: OpWaveRun): Record<string, unknown> {
  if (!spec.step) throw new Error("the spec names no step");
  const { kind: _kind, ...rest } = spec.step;
  const vars = { target: run.target, op: run.op ?? spec.op, wave: wave.name };
  return { ...(fill(rest, vars) as Record<string, unknown>), ...((run.input ? fill(run.input, vars) : {}) as Record<string, unknown>) };
}

/** The context a run's step plans and applies with: the spec's `labels.Env`, else the wave's name, and the run's target as the component. */
export function opWaveStepContext(spec: Pick<OpWavesSpec, "labels">, wave: Pick<OpWave, "name">, run: OpWaveRun): DeployContext {
  return { env: spec.labels?.Env ?? wave.name, component: run.target };
}

const registries = new WeakMap<object, Promise<CapabilityRegistry>>();

/**
 * The registry a job plans and applies through: `given`, else the project's
 * at `cwd`, loaded once per `key` (the job's options) behind a dynamic
 * import, which the wave-job runtime bundle leaves out.
 */
export function opWaveRegistry(key: object, cwd: string, given?: CapabilityRegistry): Promise<CapabilityRegistry> {
  if (given) return Promise.resolve(given);
  let found = registries.get(key);
  if (!found) {
    found = import("../components/fan-out-support").then((m) => m.fanOutRegistry(cwd));
    registries.set(key, found);
  }
  return found;
}

/** One run's plan through its step: what the gate binds, and what the apply hands back. */
export interface OpWaveStepPlan {
  target: string;
  /** The capability's member, the key `run` finds its artifact under. */
  member: string;
  planDigest: string;
  artifact?: unknown;
  part?: ChangeSetPart;
  empty: boolean;
  destructive: boolean;
  /** The run's lock grain and rows (#4552), which the apply leases on the resource grain. */
  lock?: PlannedLock;
}

/** Whether a part changes nothing, and whether it destroys or replaces something. */
export function partEffects(part: ChangeSetPart | undefined): { empty: boolean; destructive: boolean } {
  if (!part) return { empty: false, destructive: false };
  const changing = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  return { empty: changing.length === 0, destructive: changing.some((e) => e.action === "delete" || e.action === "replace") };
}

function resolveCapability(registry: CapabilityRegistry, kind: string): Capability<never, unknown> {
  if (!registry.has(kind)) throw new Error(`no capability "${kind}" is registered; the project's lexicons and capability plugins (chant.config) contribute the kinds a step can name`);
  return registry.resolve(kind);
}

/** Plan one run through the spec's step (#4545), writing its plan file at `planPath` (relative to `cwd`) as a per-run `plan` command would. */
export async function planOpWaveStep(
  at: { spec: OpWavesSpec; wave: OpWave; cwd: string; registry: CapabilityRegistry; planPath: string; lockGrain?: LockGrain | null },
  run: OpWaveRun,
): Promise<OpWaveStepPlan> {
  const { spec, wave, cwd, registry } = at;
  const capability = resolveCapability(registry, spec.step!.kind);
  if (!capability.plan) throw new Error(`the capability "${spec.step!.kind}" cannot plan, so its runs have no plan for the wave's gate to bind`);
  const input = opWaveStepInput(spec, wave, run);
  let planned: CapabilityPlan;
  let lock: PlannedLock;
  try {
    planned = await capability.plan({ ...opWaveStepContext(spec, wave, run), ...(at.lockGrain ? { lockGrain: at.lockGrain } : {}) }, input as never);
    // #4552: the run's grain (declared at base, else its lexicon's) and, on the resource grain, the rows its apply leases.
    lock = await resolvePlannedLock(capability, input, planned, at.lockGrain);
  } catch (err) {
    throw new Error(`planning ${run.target} through ${spec.step!.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof planned.planDigest !== "string" || planned.planDigest === "") throw new Error(`${spec.step!.kind} planned ${run.target} with no plan digest`);
  const holes = planned.changeSet?.member.holes ?? [];
  if (holes.length > 0 && planned.artifact === undefined) {
    throw new Error(`${run.target} was not planned: ${holes.map((h) => h.reason).join("; ")}`);
  }
  const effects = partEffects(planned.changeSet);
  // #4569: the engine's own destructive classes count too (a rewrite, a revoke), not only a delete or replace.
  if ((planned.destructive?.length ?? 0) > 0) effects.destructive = true;
  const plan: OpWaveStepPlan = {
    target: run.target,
    member: planned.member,
    planDigest: planned.planDigest,
    ...(planned.artifact !== undefined ? { artifact: planned.artifact } : {}),
    ...(planned.changeSet ? { part: planned.changeSet } : {}),
    ...effects,
    lock,
  };
  const file = join(cwd, at.planPath);
  mkdirSync(dirname(file), { recursive: true });
  let artifact: unknown;
  try {
    artifact = planned.artifact === undefined ? undefined : JSON.parse(JSON.stringify(planned.artifact));
  } catch {
    artifact = undefined;
  }
  writeFileSync(
    file,
    JSON.stringify({
      planDigest: plan.planDigest,
      ...(plan.destructive ? { destructive: true } : {}),
      ...(plan.empty ? { empty: true } : {}),
      member: plan.member,
      ...(artifact !== undefined ? { artifact } : {}),
      ...(plan.part ? { changeSet: plan.part } : {}),
    }) + "\n",
  );
  return plan;
}

/** How one run's apply through its step came out, with what the capability knew about it (#4555). */
export type OpWaveStepApply = ({ outcome: "applied"; output: unknown } | { outcome: "moved"; reason: string } | { outcome: "failed"; reason: string }) & { facts?: CapabilityTraceFacts };

/**
 * A step's facts for its span and run record (#4555): the plan's resource
 * counts by action, which core reads from the plan's change-set part, and
 * whatever the capability's `traceFacts` adds. A `traceFacts` that throws
 * is left out.
 */
export async function opWaveStepFacts(
  capability: Capability<never, unknown>,
  input: unknown,
  plan: OpWaveStepPlan,
  outcome: { output: unknown } | { error: unknown },
): Promise<CapabilityTraceFacts | undefined> {
  const counts: Record<string, number> = {};
  for (const e of plan.part?.entries ?? []) counts[`resources.${e.action}`] = (counts[`resources.${e.action}`] ?? 0) + 1;
  let own: CapabilityTraceFacts | undefined;
  try {
    own = await capability.traceFacts?.(input as never, outcome);
  } catch {
    own = undefined;
  }
  const attributes = { member: plan.member, kind: capability.kind, ...counts, ...(own?.attributes ?? {}) };
  return { attributes, ...(own?.spans?.length ? { spans: own.spans } : {}) };
}

/** Apply one run through the spec's step (#4545), with the plan the gate decided. */
export async function applyOpWaveStep(at: { spec: OpWavesSpec; wave: OpWave; registry: CapabilityRegistry }, run: OpWaveRun, plan: OpWaveStepPlan): Promise<OpWaveStepApply> {
  const { spec, wave, registry } = at;
  let capability: Capability<never, unknown>;
  try {
    capability = resolveCapability(registry, spec.step!.kind);
  } catch (err) {
    return { outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  const ctx: DeployContext = { ...opWaveStepContext(spec, wave, run), ...(plan.artifact !== undefined ? { plans: { [plan.member]: plan.artifact } } : {}) };
  const input = opWaveStepInput(spec, wave, run);
  try {
    const output = await capability.run(ctx, input as never);
    const facts = await opWaveStepFacts(capability, input, plan, { output });
    return { outcome: "applied", output, ...(facts ? { facts } : {}) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const facts = await opWaveStepFacts(capability, input, plan, { error: err });
    return { ...(isPlanMovedError(err) ? { outcome: "moved" as const, reason } : { outcome: "failed" as const, reason }), ...(facts ? { facts } : {}) };
  }
}

/** The wave's change-set document (#4551) from its runs' parts, or undefined when no run gave one. */
export function opWaveStepChangeSet(plans: readonly OpWaveStepPlan[]): ChangeSetDocument | undefined {
  const parts = plans.flatMap((p) => (p.part ? [p.part] : []));
  return parts.length > 0 ? composeChangeSet(parts) : undefined;
}

/** A policy verdict for one run, as the hold reads it. */
export interface OpWaveRunVerdict {
  result: "passed" | "denied" | "held" | "error";
  rules: string[];
  holds: string[];
  reason?: string;
}

/**
 * Run the workspace's `ci.policy` at `base` over each run's part (#4545).
 * Returns each run's verdict, or a line saying why no policy runs (the base
 * names none). Throws when the policy at base cannot be read while the
 * checkout names one, as the pull-request path does.
 */
export async function opWavePolicyVerdicts(
  at: { spec: Pick<OpWavesSpec, "name">; gate: string; env: string; base: string; head: string; cwd: string; exec?: GatePolicyExec },
  parts: ReadonlyMap<string, ChangeSetPart>,
): Promise<{ verdicts: Map<string, OpWaveRunVerdict> } | { note: string }> {
  const { prLoopPolicyAt, runPrPolicy } = await import("../components/pr-policy");
  const read = prLoopPolicyAt(at.cwd, at.base);
  if (!read.settings) return { note: read.note ?? `holds.policy: the declaration at ${at.base.slice(0, 12)} names no ci.policy, so no policy runs` };
  const verdicts = new Map<string, OpWaveRunVerdict>();
  for (const [target, part] of parts) {
    const verdict = runPrPolicy(read, { version: 1, stage: "apply", op: at.spec.name, gate: at.gate, env: at.env, pr: null, base: at.base, head: at.head, changeSet: composeChangeSet([part]) }, at.exec);
    if (!verdict) continue;
    const reason = verdict.result === "error" ? verdict.error : [...verdict.denials, ...verdict.holds].map((f) => f.message).filter(Boolean).join("; ") || undefined;
    verdicts.set(target, { result: verdict.result, rules: verdict.rules, holds: [...new Set(verdict.holds.map((h) => h.rule))].sort(), ...(reason ? { reason } : {}) });
  }
  return { verdicts };
}

/** One run's estimate: the monthly change, or why there is none. */
export type OpWaveRunCost = { target: string; monthlyDelta: number; currency?: string } | { target: string; error: string };

/** The monthly change an estimate gives, in `format`. Throws when it gives none. */
export function readCostEstimate(format: OpWaveCostFormat, stdout: string): { monthlyDelta: number; currency?: string } {
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (format === "chant") {
    const delta = num(doc.monthlyDelta);
    if (delta === undefined) throw new Error("the estimate has no monthlyDelta");
    return { monthlyDelta: delta, ...(typeof doc.currency === "string" ? { currency: doc.currency } : {}) };
  }
  // infracost breakdown --format json: diffTotalMonthlyCost, else totalMonthlyCost less pastTotalMonthlyCost.
  const diff = num(doc.diffTotalMonthlyCost);
  const total = num(doc.totalMonthlyCost);
  const past = num(doc.pastTotalMonthlyCost);
  const delta = diff ?? (total !== undefined ? total - (past ?? 0) : undefined);
  if (delta === undefined) throw new Error("the infracost document has no diffTotalMonthlyCost or totalMonthlyCost");
  return { monthlyDelta: delta, ...(typeof doc.currency === "string" ? { currency: doc.currency } : {}) };
}

const defaultHoldExec: GatePolicyExec = (argv, cwd): GatePolicyRun => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

/** The engine's plan document a capability's artifact names (`artifact.planJson`), when it names one that exists. */
function planJsonOf(artifact: unknown, cwd: string): string | undefined {
  const p = (artifact as { planJson?: unknown } | undefined)?.planJson;
  if (typeof p !== "string" || p === "") return undefined;
  const path = p.startsWith("/") ? p : join(cwd, p);
  return existsSync(path) ? path : undefined;
}

/** Price each run that changes something (#4545). A run with no estimate says why. */
export function opWaveCosts(
  hold: OpWaveCostHold,
  runs: ReadonlyArray<{ target: string; plan: string; artifact?: unknown; empty: boolean }>,
  cwd: string,
  exec: GatePolicyExec = defaultHoldExec,
): OpWaveRunCost[] {
  const format = hold.format ?? "infracost";
  const out: OpWaveRunCost[] = [];
  for (const run of runs) {
    if (run.empty) continue;
    const planJson = planJsonOf(run.artifact, cwd);
    if (hold.command.some((a) => a.includes("{planJson}")) && !planJson) {
      out.push({ target: run.target, error: "its plan names no plan document to price" });
      continue;
    }
    const argv = hold.command.map((a) => a.replaceAll("{target}", run.target).replaceAll("{plan}", run.plan).replaceAll("{planJson}", planJson ?? ""));
    const r = exec(argv, cwd);
    if (r.status !== 0) {
      out.push({ target: run.target, error: `${argv[0]} ${r.status === null ? "did not run" : `exited ${r.status}`}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}` });
      continue;
    }
    try {
      out.push({ target: run.target, ...readCostEstimate(format, r.stdout) });
    } catch (err) {
      out.push({ target: run.target, error: `the estimate cannot be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

/** What a wave's estimates come to: the sum, the digest member, and the hold line when it waits. */
export interface OpWaveCostVerdict {
  monthlyDelta: number;
  currency: string;
  unestimated: string[];
  member: WaveMember;
  /** Set when the wave waits for it: over `approveAbove`, or a run with no estimate. */
  hold?: string;
}

/** Sum a wave's estimates against `approveAbove` (#4545). */
export function opWaveCostVerdict(hold: OpWaveCostHold, costs: readonly OpWaveRunCost[]): OpWaveCostVerdict {
  const priced = costs.filter((c): c is Extract<OpWaveRunCost, { monthlyDelta: number }> => "monthlyDelta" in c);
  const unestimated = costs.filter((c) => "error" in c).map((c) => c.target).sort();
  const monthlyDelta = Math.round(priced.reduce((sum, c) => sum + c.monthlyDelta, 0) * 100) / 100;
  const currency = hold.currency ?? priced.find((c) => c.currency)?.currency ?? "USD";
  const member: WaveMember = { member: OP_WAVE_COST_MEMBER, planDigest: computePlanDigest("op-wave-cost", { approveAbove: hold.approveAbove, currency, monthlyDelta, unestimated }) };
  const signed = `${monthlyDelta >= 0 ? "+" : ""}${monthlyDelta.toFixed(2)} ${currency}`;
  const reasons: string[] = [];
  if (monthlyDelta > hold.approveAbove) reasons.push(`its monthly change of ${signed} is over holds.cost.approveAbove (${hold.approveAbove} ${currency})`);
  if (unestimated.length > 0) reasons.push(`${unestimated.join(", ")} could not be priced`);
  return { monthlyDelta, currency, unestimated, member, ...(reasons.length > 0 ? { hold: `cost: ${reasons.join(", and ")}` } : {}) };
}
