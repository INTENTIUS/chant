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
 *
 * A unit may pin its own releases (#4849): the binary Terragrunt calls and
 * Terragrunt itself. One `run --all` runs one Terragrunt with one
 * `TG_TF_PATH`, so `resolveUnit` says what each unit runs, and a wave plans
 * and applies as one `run --all` per pair of releases, each in a work
 * directory of its own. The units of a wave read none of each other, so
 * splitting it changes only how many processes run it. Each unit keeps its
 * member digest, and the wave its `(wave plan)` member. A product passes its
 * own resolver (terragucci's `UnitBinaries`), or
 * {@link terragruntUnitPinResolver}, which reads the pins from the units'
 * files and asks the product where each pinned release is.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Capability, CapabilityGroupOutcome, CapabilityGroupPlan, CapabilityPlan, DeployContext, DiscoveredRuns, GroupMember, GroupMemberOutcome, RunDiscoveryContext } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { applyTerragruntWave, defaultTerragruntExec, discoverTerragruntUnits, planTerragruntWave, TerragruntMockRefusal, type TerragruntExec } from "./run";
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
  /** The first group's work directory. */
  workDir: string;
  units: string[];
  /** Each group's units, work directory and releases (#4849). Absent on a plan from before them: one group on the step's releases. */
  groups?: TerragruntUnitGroup[];
}

/** The units of a wave that run one pair of releases, as one `run --all`. */
interface TerragruntUnitGroup {
  units: string[];
  workDir: string;
  terragrunt?: string;
  binary?: string;
}

/** What one unit runs (#4849): the `terragrunt` and the binary it calls. An unset field runs the step's. */
export interface TerragruntUnitTools {
  terragrunt?: string;
  binary?: string;
}

/** Says what a unit runs, from its pins (#4849). It may install a release, and is asked once per unit per plan or apply. */
export type TerragruntUnitResolver = (unit: string, input: TerragruntApplyStepInput) => TerragruntUnitTools | Promise<TerragruntUnitTools>;

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
  /** What each unit runs, when units pin their own releases (#4849). Unset: every unit runs the step's `terragrunt` and `binary`. */
  resolveUnit?: TerragruntUnitResolver;
}

/** The binaries a unit may pin a release of, and the file that pins each. */
const VERSION_FILES = { tofu: ".opentofu-version", terraform: ".terraform-version" } as const;
type PinnedTool = keyof typeof VERSION_FILES;
const RELEASE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** What a unit's own files pin (#4849). */
export interface TerragruntUnitPins {
  binary?: { tool: PinnedTool; version: string; source: ".opentofu-version" | ".terraform-version" | "required_version" };
  terragrunt?: { version: string; source: "terragrunt_version_constraint" };
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");

/** Every exact `required_version` (`= 1.13.1` or `1.13.1`) in one directory's Terraform files. */
function exactRequiredVersions(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".tf") || n.endsWith(".tofu") || n.endsWith(".tf.json") || n.endsWith(".tofu.json"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const f = join(dir, n);
    if (!statSync(f).isFile()) continue;
    const m = stripComments(readFileSync(f, "utf-8")).match(/required_version\s*=\s*"\s*=?\s*(\d+\.\d+\.\d+)\s*"/);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * What `unit` (relative to `dir`) pins, read as terragucci reads it: the
 * binary from a `.opentofu-version` (tofu) or `.terraform-version`
 * (terraform), whose first line that is not a comment is an exact release,
 * else one exact `required_version` in its Terraform files; Terragrunt from
 * an exact `terragrunt_version_constraint` (`"= 1.1.5"`) in its
 * `terragrunt.hcl`. `binary` is the one the step runs: only tofu and
 * terraform are pinned. A product's own pins, such as terragucci.yml's
 * `version` map, go in its own resolver.
 */
export function terragruntUnitPins(dir: string, unit: string, binary: string): TerragruntUnitPins {
  const at = join(dir, unit);
  const out: TerragruntUnitPins = {};
  const name = basename(binary);
  if (name === "tofu" || name === "terraform") {
    const file = join(at, VERSION_FILES[name]);
    const line = existsSync(file) ? readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#")) : undefined;
    const v = line?.replace(/^v/, "");
    const required = exactRequiredVersions(at);
    if (v && RELEASE.test(v)) out.binary = { tool: name, version: v, source: VERSION_FILES[name] };
    else if (required.length === 1) out.binary = { tool: name, version: required[0]!, source: "required_version" };
  }
  const hcl = join(at, "terragrunt.hcl");
  if (existsSync(hcl)) {
    const text = readFileSync(hcl, "utf-8").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
    const tg = /^\s*terragrunt_version_constraint\s*=\s*"\s*=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*"/m.exec(text)?.[1];
    if (tg) out.terragrunt = { version: tg, source: "terragrunt_version_constraint" };
  }
  return out;
}

export interface TerragruntUnitPinResolverOptions {
  /** The path of a pinned release's executable, installing it if it must. Asked once per tool and version. */
  release: (tool: PinnedTool | "terragrunt", version: string, unit: string) => string | Promise<string>;
  /** The releases the step's own `binary` and `terragrunt` are: a unit pinned to one of them runs the step's. */
  carried?: Partial<Record<PinnedTool | "terragrunt", string>>;
}

/** A {@link TerragruntUnitResolver} from the units' own pins ({@link terragruntUnitPins}). The step's `binary` defaults to tofu, as Terragrunt's does. */
export function terragruntUnitPinResolver(options: TerragruntUnitPinResolverOptions): TerragruntUnitResolver {
  const releases = new Map<string, Promise<string>>();
  const releaseOf = (tool: PinnedTool | "terragrunt", version: string, unit: string): Promise<string> => {
    const key = `${tool}@${version}`;
    let p = releases.get(key);
    if (!p) {
      p = Promise.resolve(options.release(tool, version, unit));
      releases.set(key, p);
    }
    return p;
  };
  return async (unit, input) => {
    const pins = terragruntUnitPins(dirOf(input), unit, input.binary ?? "tofu");
    const out: TerragruntUnitTools = {};
    if (pins.binary && pins.binary.version !== options.carried?.[pins.binary.tool]) out.binary = await releaseOf(pins.binary.tool, pins.binary.version, unit);
    if (pins.terragrunt && pins.terragrunt.version !== options.carried?.terragrunt) out.terragrunt = await releaseOf("terragrunt", pins.terragrunt.version, unit);
    return out;
  };
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

/** The step's input with what `unit` runs in place of the step's `terragrunt` and `binary`. */
async function unitInput(resolveUnit: TerragruntUnitResolver | undefined, input: TerragruntApplyStepInput, unit: string): Promise<TerragruntApplyStepInput> {
  if (!resolveUnit) return input;
  const t = await resolveUnit(unit, input);
  return { ...input, ...(t.terragrunt ? { terragrunt: t.terragrunt } : {}), ...(t.binary ? { binary: t.binary } : {}) };
}

/** A wave's units by the pair of releases they run, the step's own pair first, each with the input its `run --all` takes. */
async function groupUnits(resolveUnit: TerragruntUnitResolver | undefined, input: TerragruntApplyStepInput, units: readonly string[]): Promise<{ input: TerragruntApplyStepInput; units: string[] }[]> {
  const key = (i: TerragruntApplyStepInput): string => JSON.stringify([i.terragrunt ?? null, i.binary ?? null]);
  const own = key(input);
  const byKey = new Map<string, { input: TerragruntApplyStepInput; units: string[] }>();
  for (const u of units) {
    const i = await unitInput(resolveUnit, input, u);
    const k = key(i);
    if (!byKey.has(k)) byKey.set(k, { input: i, units: [] });
    byKey.get(k)!.units.push(u);
  }
  const groups = [...byKey.entries()];
  groups.sort(([a], [b]) => (a === own ? -1 : b === own ? 1 : 0));
  return groups.map(([, g]) => g);
}

/**
 * Plan each group with its own `run --all`. A group whose units would read
 * `mock_outputs` is refused as one wave is: every group still plans, then one
 * refusal names every read.
 */
async function planGroups(exec: TerragruntExec, groups: { input: TerragruntApplyStepInput; units: string[] }[], env: Record<string, string> | undefined): Promise<{ groups: TerragruntUnitGroup[]; plans: Map<string, CapabilityPlan> }> {
  const reads: TerragruntMockRefusal["reads"] = [];
  const out: TerragruntUnitGroup[] = [];
  const plans = new Map<string, CapabilityPlan>();
  for (const g of groups) {
    let planned: Awaited<ReturnType<typeof planUnits>>;
    try {
      planned = await planUnits(exec, g.input, g.units, env);
    } catch (e) {
      if (e instanceof TerragruntMockRefusal && groups.length > 1) {
        reads.push(...e.reads);
        continue;
      }
      throw e;
    }
    out.push({ units: g.units, workDir: planned.workDir, ...(g.input.terragrunt ? { terragrunt: g.input.terragrunt } : {}), ...(g.input.binary ? { binary: g.input.binary } : {}) });
    for (const [u, p] of planned.plans) plans.set(u, p);
  }
  if (reads.length > 0) throw new TerragruntMockRefusal(reads);
  return { groups: out, plans };
}

const isWaveArtifact = (v: unknown): v is TerragruntWaveArtifact => (v as { kind?: unknown } | undefined)?.kind === "terragrunt-apply" && Array.isArray((v as { units?: unknown }).units);
const isUnitArtifact = (v: unknown): v is TerragruntUnitArtifact => (v as { kind?: unknown } | undefined)?.kind === "terragrunt-apply-unit";

/** The `terragrunt-apply` capability, with `deps` in place of the defaults. */
export function terragruntApplyCapability(deps: TerragruntApplyDeps = {}): Capability<TerragruntApplyStepInput, TerragruntApplyStepOutput> {
  const exec = deps.exec ?? defaultTerragruntExec;
  const resolveUnit = deps.resolveUnit;
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
      const { plans } = await planUnits(exec, await unitInput(resolveUnit, input, input.unit), [input.unit], ctx.processEnv);
      return plans.get(input.unit)!;
    },

    async run(ctx: DeployContext, input: TerragruntApplyStepInput): Promise<TerragruntApplyStepOutput> {
      const given = ctx.plans?.[input.unit];
      const own = await unitInput(resolveUnit, input, input.unit);
      // A unit with no plan from the wave plans now and applies that plan.
      const workDir = isUnitArtifact(given) ? given.workDir : (await planUnits(exec, own, [input.unit], ctx.processEnv)).workDir;
      const applied = await applyUnits(exec, own, [input.unit], workDir, ctx.processEnv);
      const result = applied.results.find((r) => r.unit === input.unit);
      if (result?.status !== "succeeded") throw new Error(`terragrunt-apply: ${input.unit}: ${result?.error ?? "Terragrunt did not apply it"}`);
      return { unit: input.unit, applied: true };
    },

    async planGroup(_ctx, members): Promise<CapabilityGroupPlan> {
      const { input, units, env } = shared(members);
      for (const m of members) await m.ctx.afterInit?.();
      const { groups, plans } = await planGroups(exec, await groupUnits(resolveUnit, input, units), env);
      const artifact: TerragruntWaveArtifact = { kind: "terragrunt-apply", workDir: groups[0]!.workDir, units: [...units], groups };
      // One group hashes as a wave always has; more name each group's units. Not the releases' paths, which depend on where a job installed them: each unit's plan digest covers what its release planned.
      const digest = computePlanDigest("terragrunt-apply-wave", {
        units: [...units].sort(),
        destroy: input.destroy === true,
        ...(groups.length > 1 ? { groups: groups.map((g) => [...g.units].sort()).sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000"))) } : {}),
      });
      return { members: Object.fromEntries(members.map((m) => [m.component, plans.get(m.input?.unit ?? (m.step.unit as string))!])), digest, artifact };
    },

    async runGroup(_ctx, run, members): Promise<CapabilityGroupOutcome> {
      const { input, units, env } = shared(members);
      if (!isWaveArtifact(run.artifact)) throw new Error("terragrunt-apply: no plan of the wave to apply");
      const planned = new Set(run.artifact.units);
      const unplanned = units.filter((u) => !planned.has(u));
      if (unplanned.length > 0) throw new Error(`terragrunt-apply: ${unplanned.join(", ")} ${unplanned.length === 1 ? "is" : "are"} not in the wave's plan`);
      const want = new Set(units);
      const groups: TerragruntUnitGroup[] = run.artifact.groups ?? [{ units: run.artifact.units, workDir: run.artifact.workDir, ...(input.terragrunt ? { terragrunt: input.terragrunt } : {}), ...(input.binary ? { binary: input.binary } : {}) }];
      const grouped = new Set(groups.flatMap((g) => g.units));
      const ungrouped = units.filter((u) => !grouped.has(u));
      if (ungrouped.length > 0) throw new Error(`terragrunt-apply: ${ungrouped.join(", ")} ${ungrouped.length === 1 ? "is" : "are"} in no group of the wave's plan`);
      const applied: { results: Awaited<ReturnType<typeof applyUnits>>["results"]; code: number | null } = { results: [], code: 0 };
      // Each group applies its own saved plans with its own releases.
      for (const g of groups) {
        const mine = g.units.filter((u) => want.has(u));
        if (mine.length === 0) continue;
        const { terragrunt: _tg, binary: _bin, ...rest } = input;
        const a = await applyUnits(exec, { ...rest, ...(g.terragrunt ? { terragrunt: g.terragrunt } : {}), ...(g.binary ? { binary: g.binary } : {}) }, mine, g.workDir, env);
        applied.results.push(...a.results);
        if (applied.code === 0) applied.code = a.code;
      }
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
