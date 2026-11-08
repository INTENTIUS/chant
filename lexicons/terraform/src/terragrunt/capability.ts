/**
 * `terragrunt-apply` (#4842): Terragrunt units as an op wave's step. A
 * `discover` wave finds its units at plan time from `terragrunt find`, and a
 * `together` wave plans and applies them with one `terragrunt run --all`, the
 * way a Terragrunt repo runs a layer of its graph:
 *
 * ```json
 * { "step": { "kind": "terragrunt-apply", "unit": "{target}" },
 *   "waves": [{ "name": "layer", "runs": [], "discover": true, "together": true },
 *             { "name": "rest", "runs": [], "discover": true, "together": true, "rest": true }] }
 * ```
 *
 * - `discoverRuns` runs `terragrunt find` and cuts the units into waves by
 *   their dependencies (`terragruntWaves`), or, with `layers`, cuts each
 *   listed wave again by the graph (`terragruntListedWaves`). It answers
 *   wave k's units and how many waves there are.
 * - `planGroup` plans the wave's units with one `run --all` into the work
 *   directory (`planTerragruntWave`, which refuses a wave that would read
 *   `mock_outputs`). Each unit's member is its change-set part, and its
 *   artifact names its plan JSON (`planJson`), which a cost hold and the
 *   after-plan hooks read. A unit that did not plan fails the wave.
 * - `runGroup` applies exactly those saved plans with one `run --all`
 *   (`applyTerragruntWave`) and says how each unit's part ended.
 * - `plan` and `run` do the same for one unit, for a wave planned run by
 *   run (a share job's slice).
 *
 * A run hook's `processEnv` is laid over the environment Terragrunt runs
 * with; the units of one `run --all` must agree on it. Terragrunt has no
 * init of its own before the plan, so `afterInit` is called before it plans.
 * A product passes its own `exec` (`terragruntApplyCapability`) to wrap
 * Terragrunt, as terragucci adds its lock timeout and its backend bootstrap.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Capability, CapabilityGroupOutcome, CapabilityGroupPlan, CapabilityPlan, DeployContext, DiscoveredRuns, GroupMember, GroupMemberOutcome, RunDiscoveryContext } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { applyTerragruntWave, defaultTerragruntExec, discoverTerragruntUnits, planTerragruntWave, type TerragruntExec } from "./run";
import { terragruntListedWaves, terragruntWaves } from "./units";

/** The step's input. Each string has `{target}`, `{op}` and `{wave}` filled per run in an op wave. */
export interface TerragruntApplyStepInput {
  /** The unit, by path relative to `dir`: `{target}`. */
  unit: string;
  /** The project directory Terragrunt runs in. Default: the job's directory. */
  dir?: string;
  /** The `terragrunt` executable. Default `terragrunt` on PATH. */
  terragrunt?: string;
  /** The binary Terragrunt calls (`TG_TF_PATH`). Unset leaves Terragrunt's own choice. */
  binary?: string;
  /** Globs discovery leaves out, beside catalog templates and the module cache. */
  exclude?: string[];
  /** Discovery: the waves as a pipeline lists them, each cut again by the graph. Default: the graph's own layers. */
  layers?: string[][];
  /** Discovery without `layers`: unit globs that form the first waves. */
  canary?: string[];
  /** `--parallelism` for a `run --all`. */
  parallelism?: number;
  /** Where the saved plans go, relative to `dir`. Default `.chant/terragrunt-apply`. */
  workDir?: string;
  /** Plan a destroy (`plan -destroy`, `--filter-allow-destroy`). */
  destroy?: boolean;
}

/** What `run` and `runGroup` hand back for a unit. */
export interface TerragruntApplyStepOutput {
  unit: string;
  applied: true;
}

/** What `plan` and `planGroup` keep for the apply: the work directory and the units planned into it. */
interface TerragruntWaveArtifact {
  kind: "terragrunt-apply";
  workDir: string;
  units: string[];
}

/** A unit's own artifact: its plan document, for `{planJson}`. */
interface TerragruntUnitArtifact {
  kind: "terragrunt-apply-unit";
  workDir: string;
  unit: string;
  planJson: string;
}

export interface TerragruntApplyDeps {
  /** How Terragrunt runs. Default {@link defaultTerragruntExec}. */
  exec?: TerragruntExec;
}

const DEFAULT_WORK_DIR = ".chant/terragrunt-apply";

const dirOf = (input: TerragruntApplyStepInput): string => input.dir ?? process.cwd();

/** The work directory of a `run --all` over `units`: one per set of units, so a wave and a unit of it never share one. */
function workDirOf(input: TerragruntApplyStepInput, units: readonly string[]): string {
  const key = createHash("sha256").update(JSON.stringify([...units].sort())).digest("hex").slice(0, 16);
  return join(input.workDir ?? DEFAULT_WORK_DIR, key);
}

/** `exec` with `env` laid over what each call adds. */
function withEnv(exec: TerragruntExec, env: Record<string, string> | undefined): TerragruntExec {
  if (!env) return exec;
  return (file, args, o) => exec(file, args, { ...o, env: { ...o.env, ...env } });
}

/** The settings every unit of one `run --all` shares; throws when members disagree. */
function shared(members: readonly GroupMember<TerragruntApplyStepInput>[]): { input: TerragruntApplyStepInput; units: string[]; env?: Record<string, string> } {
  if (members.length === 0) throw new Error("terragrunt-apply: a wave needs at least one unit");
  const inputs = members.map((m) => m.input ?? (m.step as unknown as TerragruntApplyStepInput));
  for (const i of inputs) if (typeof i.unit !== "string" || i.unit === "") throw new Error("terragrunt-apply: each run names its unit");
  const first = inputs[0]!;
  const key = (i: TerragruntApplyStepInput) => JSON.stringify([i.dir, i.terragrunt, i.binary, i.parallelism, i.workDir, i.destroy === true]);
  if (inputs.some((i) => key(i) !== key(first))) throw new Error("terragrunt-apply: the wave's units run as one run --all, so they need the same dir, terragrunt, binary, parallelism, workDir and destroy");
  const envs = members.map((m) => JSON.stringify(m.ctx.processEnv ?? {}));
  if (envs.some((e) => e !== envs[0])) throw new Error("terragrunt-apply: the wave's units run as one run --all with one environment, and the run hooks gave them different ones");
  const env = members[0]!.ctx.processEnv;
  return { input: first, units: inputs.map((i) => i.unit), ...(env ? { env } : {}) };
}

/** Each unit's plan from a planned wave, or throws naming each unit that did not plan. */
function unitPlans(parts: readonly ChangeSetPart[], units: readonly string[], workDir: string, dir: string): Map<string, CapabilityPlan> {
  const failed = parts.filter((p) => p.member.status === "failed" || typeof p.member.planDigest !== "string");
  if (failed.length > 0) throw new Error(`terragrunt-apply: ${failed.map((p) => `${p.member.member}: ${p.member.error ?? "not planned"}`).join("; ")}`);
  const out = new Map<string, CapabilityPlan>();
  for (const part of parts) {
    const unit = part.member.member;
    const artifact: TerragruntUnitArtifact = { kind: "terragrunt-apply-unit", workDir, unit, planJson: join(dir, workDir, "json", unit, "tfplan.json") };
    out.set(unit, { member: unit, planDigest: part.member.planDigest as string, artifact, changeSet: part });
  }
  const missing = units.filter((u) => !out.has(u));
  if (missing.length > 0) throw new Error(`terragrunt-apply: Terragrunt planned no ${missing.join(", ")}`);
  return out;
}

async function planUnits(exec: TerragruntExec, input: TerragruntApplyStepInput, units: readonly string[], env: Record<string, string> | undefined): Promise<{ workDir: string; plans: Map<string, CapabilityPlan> }> {
  const dir = dirOf(input);
  const workDir = workDirOf(input, units);
  const planned = await planTerragruntWave({
    dir,
    units,
    workDir,
    exec: withEnv(exec, env),
    ...(input.terragrunt ? { terragrunt: input.terragrunt } : {}),
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.parallelism !== undefined ? { parallelism: input.parallelism } : {}),
    ...(input.destroy ? { destroy: true } : {}),
  });
  return { workDir, plans: unitPlans(planned.parts, units, workDir, dir) };
}

async function applyUnits(exec: TerragruntExec, input: TerragruntApplyStepInput, units: readonly string[], workDir: string, env: Record<string, string> | undefined) {
  return applyTerragruntWave({
    dir: dirOf(input),
    units,
    workDir,
    exec: withEnv(exec, env),
    ...(input.terragrunt ? { terragrunt: input.terragrunt } : {}),
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.parallelism !== undefined ? { parallelism: input.parallelism } : {}),
    ...(input.destroy ? { destroy: true } : {}),
  });
}

const isWaveArtifact = (v: unknown): v is TerragruntWaveArtifact => (v as { kind?: unknown } | undefined)?.kind === "terragrunt-apply" && Array.isArray((v as { units?: unknown }).units);
const isUnitArtifact = (v: unknown): v is TerragruntUnitArtifact => (v as { kind?: unknown } | undefined)?.kind === "terragrunt-apply-unit";

/** The `terragrunt-apply` capability, with `deps` in place of the defaults. */
export function terragruntApplyCapability(deps: TerragruntApplyDeps = {}): Capability<TerragruntApplyStepInput, TerragruntApplyStepOutput> {
  const exec = deps.exec ?? defaultTerragruntExec;
  return {
    kind: "terragrunt-apply",
    rollbackPolicy: "needs-opt-out",
    // A unit plans and applies as a whole, and Terragrunt takes each unit's own backend lock.
    defaultLockGrain: () => "target",

    async discoverRuns(ctx: RunDiscoveryContext, input: TerragruntApplyStepInput): Promise<DiscoveredRuns> {
      const found = await discoverTerragruntUnits({
        dir: dirOf(input),
        exec,
        ...(input.terragrunt ? { terragrunt: input.terragrunt } : {}),
        ...(input.binary ? { binary: input.binary } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
      });
      const waves = (input.layers ? terragruntListedWaves(input.layers, found.units) : terragruntWaves(found.units, input.canary ? { canary: input.canary } : {})).filter((w) => w.length > 0);
      return { targets: waves[ctx.wave.number - 1] ?? [], waves: waves.length };
    },

    async plan(ctx: DeployContext, input: TerragruntApplyStepInput): Promise<CapabilityPlan> {
      if (typeof input.unit !== "string" || input.unit === "") throw new Error("terragrunt-apply: the step names no unit");
      await ctx.afterInit?.();
      const { plans } = await planUnits(exec, input, [input.unit], ctx.processEnv);
      return plans.get(input.unit)!;
    },

    async run(ctx: DeployContext, input: TerragruntApplyStepInput): Promise<TerragruntApplyStepOutput> {
      const given = ctx.plans?.[input.unit];
      // A unit with no plan from the wave plans now and applies that plan.
      const workDir = isUnitArtifact(given) ? given.workDir : (await planUnits(exec, input, [input.unit], ctx.processEnv)).workDir;
      const applied = await applyUnits(exec, input, [input.unit], workDir, ctx.processEnv);
      const result = applied.results.find((r) => r.unit === input.unit);
      if (result?.status !== "succeeded") throw new Error(`terragrunt-apply: ${input.unit}: ${result?.error ?? "Terragrunt did not apply it"}`);
      return { unit: input.unit, applied: true };
    },

    async planGroup(_ctx, members): Promise<CapabilityGroupPlan> {
      const { input, units, env } = shared(members);
      for (const m of members) await m.ctx.afterInit?.();
      const { workDir, plans } = await planUnits(exec, input, units, env);
      const artifact: TerragruntWaveArtifact = { kind: "terragrunt-apply", workDir, units: [...units] };
      const digest = computePlanDigest("terragrunt-apply-wave", { units: [...units].sort(), destroy: input.destroy === true });
      return { members: Object.fromEntries(members.map((m) => [m.component, plans.get(m.input?.unit ?? (m.step.unit as string))!])), digest, artifact };
    },

    async runGroup(_ctx, run, members): Promise<CapabilityGroupOutcome> {
      const { input, units, env } = shared(members);
      if (!isWaveArtifact(run.artifact)) throw new Error("terragrunt-apply: no plan of the wave to apply");
      const planned = new Set(run.artifact.units);
      const unplanned = units.filter((u) => !planned.has(u));
      if (unplanned.length > 0) throw new Error(`terragrunt-apply: ${unplanned.join(", ")} ${unplanned.length === 1 ? "is" : "are"} not in the wave's plan`);
      const applied = await applyUnits(exec, input, units, run.artifact.workDir, env);
      const byUnit = new Map(applied.results.map((r) => [r.unit, r]));
      const out: Record<string, GroupMemberOutcome> = {};
      for (const m of members) {
        const unit = m.input?.unit ?? (m.step.unit as string);
        const r = byUnit.get(unit);
        out[m.component] = r?.status === "succeeded" ? { status: "applied" } : { status: "failed", error: r?.error ?? "Terragrunt did not apply it" };
      }
      return { members: out, ...(applied.code !== 0 && applied.results.every((r) => r.status === "succeeded") ? { error: `terragrunt exited ${applied.code}` } : {}) };
    },
  };
}

/** `terragrunt-apply` with Terragrunt on PATH. */
export const terragruntApply: Capability<TerragruntApplyStepInput, TerragruntApplyStepOutput> = terragruntApplyCapability();
