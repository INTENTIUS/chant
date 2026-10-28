/**
 * `terraformCapabilityPlugin` — the terraform lexicon's capability plugin
 * (#3049). It contributes `terraform-apply`, which lets a component deploy a
 * root named in `terraform.roots`, so a change across many roots runs as a
 * `chant components fan-out`: in an order derived from each component's
 * `dependsOn`, and, with `--wave-gate`, a gate per wave bound to the wave's
 * set digest.
 *
 * The step is `{ kind: "terraform-apply", root: "<name>" }`, with optional
 * `vars` (passed as `-var`, so `stackOutput()` can hand one root's output to
 * another) and `cwd`. It works the same for `terraform`, `tofu` and
 * `choudoufu`, since all three go through the lexicon's activities.
 *
 * ## Plan, then apply exactly that plan
 *
 * `plan` runs `init` and `plan -out`, and answers with the root as the member
 * and `terraformPlanDigest` as its digest: the value a `TerraformApplyOp`
 * gate on this root alone binds (#2300). A gated-wave fan-out folds those into
 * the wave's set digest and hands the plan file back to `run`, which applies
 * that file and nothing else. terraform and tofu refuse a saved plan whose
 * state moved since it was written; choudoufu re-plans against the live
 * system and refuses with exit 3 when its fresh plan differs (choudoufu
 * #878). Either refusal fails the step. choudoufu's refusal of a plan the
 * wave handed `run` throws {@link TerraformPlanMovedError}, so the command
 * that applied it exits 4, the table's moved code (#3997, #4553). terraform's and tofu's stale-plan error
 * is not classified and exits 1.
 *
 * Run without a wave plan (`chant run --components`, or a fan-out with no
 * wave gate), `run` plans and applies in one go, which is what `terraform
 * apply` with no plan file does too.
 *
 * ## What the plan says about the root's outputs (#3999)
 *
 * `plan` answers the outputs the root will have once that plan applies
 * (`terraformPlannedOutputs`): `show -json`'s `planned_values.outputs`, less
 * each output whose `output_changes` entry is unknown after apply. A pull
 * request's plan reads a dependent's `stackOutput()` references from there
 * when both roots are in the change.
 *
 * A root whose `vars` read an output not known yet (`DeployContext.unresolvedInputs`)
 * cannot be planned as it stands: terraform takes no unknown variable. It is
 * previewed instead (#4463, `./placeholder-preview.ts`): planned with a
 * stand-in per variable that holds no value, typed from the root's
 * `variable` block, with every attribute and output a stand-in drives marked
 * unknown after apply. The member lists the variables under `placeholders`,
 * and its artifact is the preview's shape, never a plan file. The apply plans
 * the root again once the upstream applied, and core covers that round with
 * the first approval when its shape is within the preview's; a `run` handed
 * the shape itself holds the fresh plan to it. When no preview can be made
 * (an undeclared variable, a `count` or `for_each` over a stand-in, a
 * placeholder plan that fails) the member stays a hole naming the roots it
 * waits on, and the hole's reason says why there is no preview.
 *
 * ## The plan's shape (#4436)
 *
 * `plan` also answers `shape`, `terraformPlanShape` over `show -json`: each
 * resource the plan changes with its action, type, replacement, the
 * attributes that differ and the ones unknown after apply. Core's
 * `coveredRound` compares it with the shape of a later plan of the root. A
 * previewed root's shape lists the upstreams it read as unknown inputs; a
 * root that stays a hole has no plan, so no shape, and stays uncovered.
 *
 * ## choudoufu roots in a gated wave (#3459)
 *
 * A live choudoufu root that `live-plan-set` can plan as chant would (no
 * `vars`, no var files, no backend config; see `choudoufuWaveRoot`) goes
 * through choudoufu's own set commands (choudoufu#1754), which need
 * choudoufu v0.22.0 (`MIN_CHOUDOUFU_WAVES_VERSION`):
 *
 * - `plan` runs `live-plan-set -json` over the root as a one-root set. The
 *   wave gate still binds chant's `terraformPlanDigest` of the plan the
 *   document embeds, the same string a single-root gate binds. choudoufu's
 *   set digest is kept for the apply, and its root digest is the change-set
 *   part's `nativeDigest`.
 * - `run` hands that document and choudoufu's set digest to
 *   `live-wave-apply`, which plans the root again and applies nothing when
 *   the plan moved (exit 3).
 * - choudoufu's resume file is kept in the fan-out's attempt record
 *   (`DeployContext.carry`) after every apply, landed or not, and written
 *   back on the next attempt when it was written for the same set digest.
 *
 * chant's waves stay the order. Each root is its own one-root set, so
 * choudoufu's wave over it is always wave 1.
 *
 * ## Composed runs (#4447)
 *
 * With `terraform.compose.enabled`, a group core forms of `terraform-apply`
 * components that read each other (ws-107) plans as one plan and applies as
 * one apply of a composed root, and a member's read of another member's new
 * output is not a hole: the apply passes the value on. `groupReads`,
 * `groupFallback`, `planGroup` and `runGroup` are in `./compose-group.ts`.
 *
 * ## A choudoufu member's outputs, for another member (#4455)
 *
 * The plugin also contributes {@link choudoufuOutputSource} to core's
 * `member-outputs` verb (`CapabilityPlugin.engineOutputSources`), which is
 * how a chant member's parameters read a choudoufu member of the same
 * workspace: `choudoufu output -json` in the member's directory for the
 * applied values, and `live-plan-set -json` over it for the planned ones,
 * read the way `plan` reads a root's (`terraformPlannedOutputs`). The member
 * is not a `terraform.roots` entry of the reading project; its directory
 * comes from the workspace declaration.
 *
 * ## Op waves (#4545)
 *
 * The step is what an op wave's `step` names to plan and apply each root
 * through chant (`chant run wave`), so terragucci's waves and plywood's run
 * the engine in chant. Three inputs come from terragucci's wave callbacks:
 *
 * - `lockTimeout` (default `5m`, `false` for none): `plan` and `apply` wait
 *   that long for another run's state lock, unless `TF_CLI_ARGS` sets
 *   `-lock-timeout` already (`../lock-timeout.ts`).
 * - `cone`: a revision. A live choudoufu root plans the cone of the change
 *   since it (`plan -cone`, `../cone.ts`), and the cone's targets join the
 *   plan digest, so an approval of one cone counts for no other. Such a root
 *   plans with `plan`, never as a one-root set.
 * - `reads`: vars read from another root's outputs, Atmos's
 *   `!terraform.state` (`../state-reads.ts`). An upstream with no such output
 *   yet makes the member a hole naming it, so the root is never planned on a
 *   stand-in.
 *
 * Every plan also writes its `show -json` beside the plan file and names it
 * as `artifact.planJson`, the document a wave's cost hold prices
 * (`../cost-hold.ts`).
 */

import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Capability, DeployContext, CapabilityPlan, PlannedOutputs } from "@intentius/chant/components/capability";
import { loadChantConfigUpward } from "@intentius/chant/config";
import {
  PlanShapeMovedError,
  planShapeDifferences,
  planShapeDigest,
  type PlanShapeArtifact,
} from "@intentius/chant/components/covered-round";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { EngineMemberRef, EngineOutputSource, EnginePlannedOutputs } from "@intentius/chant/components/verbs/member-outputs";
import {
  choudoufuMemberOutputs,
  choudoufuMemberPlanSet,
  choudoufuPlanSet,
  choudoufuWaveApply,
  choudoufuWaveRoot,
  terraformApply,
  terraformInit,
  terraformOutputs,
  terraformPlan,
} from "../op/activities/terraform";
import { terraformPlanMoved } from "../exit-codes";
import { terraformPlanShape } from "../plan-shape";
import { plannerForBinary, terraformChangeSetPart } from "../change-set";
import { terraformDefaultLockGrain, terraformLockGrainRefusal, terraformLockRows, terraformLockRowsFromPart } from "../lock-rows";
import type { LockRow } from "@intentius/chant/lifecycle/lock-rows";
import type { TerraformConfig } from "../config";
import { rootTexts } from "../compose/hcl";
import { declaredVariables } from "../compose/root";
import { terraformComposeGroup } from "./compose-group";
import { markPlaceholderDriven, placeholderVars, waitingHole } from "./placeholder-preview";
import { terraformReleaseInputs } from "./release-inputs";
import { terraformTraceFacts } from "./trace-facts";
import { DEFAULT_LOCK_TIMEOUT, isLockTimeout } from "../lock-timeout";
import { conePlanDigest, type PlanCone } from "../cone";
import { fillStateReads, stateReadsProblems, waitingReadsReason, type TerraformStateRead } from "../state-reads";
import { terraformStateOpCapabilities } from "../state-ops";
import { terraformActionCapability } from "../action-ops";

/** The `terraform-apply` step's input. */
export interface TerraformApplyStepInput {
  /** Key into `terraform.roots`. Also the member's name in a wave's set digest. */
  root: string;
  /** Input variables, after the root's var files. See `TerraformPlanArgs.vars`. */
  vars?: Record<string, unknown>;
  /** Where the `chant.config.*` search starts. Default: the current directory. */
  cwd?: string;
  /** The root's files from here instead of its entry's `dir` (#4542): a promote under a release sets it to the recorded copy. */
  dir?: string;
  /** How long `plan` and `apply` wait for a state lock (#4545). Default `"5m"`; `false` passes no flag. */
  lockTimeout?: string | false;
  /** choudoufu live roots (#4545): plan the cone of the change since this revision. */
  cone?: string;
  /** Vars read from other roots' outputs (#4545), Atmos's `!terraform.state`. The step's `vars` win over them. */
  reads?: TerraformStateRead[];
}

/** What `terraform-apply` returns. `outputs` is what a dependent's `stackOutput()` reads. */
export interface TerraformApplyStepOutput {
  root: string;
  planDigest: string;
  /** Whether the plan applied came from the wave's plan rather than one made here. */
  fromWavePlan: boolean;
  /** `terraform output -json`, as `{ name: value }`. */
  outputs: Record<string, unknown>;
}

/** What `plan` hands `run` through `DeployContext.plans`. */
interface PlannedRoot {
  planFile: string;
  planDigest: string;
  /** The plan's `show -json`, beside the plan file (#4545), for a cost hold to price. */
  planJson?: string;
  /** The cone the plan covered, when asked for one (#4545). */
  cone?: PlanCone;
  /** A choudoufu root's rows on the resource lock grain (#4552), from the plan's `show -json`. */
  lockRows?: LockRow[];
}

/** The lock timeout a step's plan and apply pass (#4545). */
function lockTimeoutOf(input: TerraformApplyStepInput): { lockTimeout?: string } {
  if (input.lockTimeout === false) return {};
  const value = input.lockTimeout ?? DEFAULT_LOCK_TIMEOUT;
  if (!isLockTimeout(value)) throw new Error(`terraform-apply: root "${input.root}": lockTimeout "${String(value)}" is not a duration such as "5m"`);
  return { lockTimeout: value };
}

/**
 * The step's input with its `reads` filled (#4545): each upstream's outputs
 * read once, the values under the step's own `vars`. `waiting` when an
 * upstream has no such output yet. Throws when a state cannot be read.
 */
async function withReads(input: TerraformApplyStepInput): Promise<{ input: TerraformApplyStepInput } | { waiting: string; upstreams: string[] }> {
  const reads = input.reads ?? [];
  if (reads.length === 0) return { input };
  const problems = stateReadsProblems(reads);
  if (problems.length > 0) throw new Error(`terraform-apply: root "${input.root}": ${problems.join("; ")}`);
  const filled = await fillStateReads(reads, async (root) => {
    const at = { root, ...(input.cwd ? { cwd: input.cwd } : {}) };
    await terraformInit(at);
    return terraformOutputs(at);
  });
  if (filled.errors.length > 0) throw new Error(`terraform-apply: root "${input.root}": ${filled.errors.join("; ")}`);
  if (filled.waiting.length > 0) return { waiting: waitingReadsReason(filled.waiting), upstreams: [...new Set(filled.waiting.map((w) => w.read.root))].sort() };
  return { input: { ...input, vars: { ...filled.vars, ...(input.vars ?? {}) } } };
}

/** A root whose reads wait on an upstream (#4545): a hole naming it, and a digest over the root and those upstreams. */
function waitingOnReads(ctx: DeployContext, input: TerraformApplyStepInput, waiting: { waiting: string; upstreams: string[] }): CapabilityPlan {
  const planDigest = computePlanDigest("terraform-apply-reads-waiting", { env: ctx.env, root: input.root, upstreams: waiting.upstreams });
  const changeSet: ChangeSetPart = {
    member: { member: input.root, lexicon: "terraform", planner: "chant", status: "planned", planDigest, holes: [{ address: input.root, type: "terraform_root", reason: waiting.waiting }] },
    entries: [],
  };
  return { member: input.root, planDigest, changeSet };
}

const rootArgs = (input: TerraformApplyStepInput) => ({ root: input.root, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.dir ? { dir: input.dir } : {}) });

function requireRoot(input: TerraformApplyStepInput): void {
  if (typeof input.root !== "string" || input.root === "") {
    throw new Error('terraform-apply: "root" is required and names an entry in terraform.roots');
  }
}

async function planRoot(input: TerraformApplyStepInput, targets?: string[]): Promise<PlannedRoot & { changeSet?: ChangeSetPart; json?: unknown }> {
  requireRoot(input);
  await terraformInit(rootArgs(input));
  // One `show -json` per plan (#4479): its document is the digest, the change
  // set, the planned outputs and the shape. Nothing here reads the
  // `-no-color` render, so the plan skips it.
  const planned = await terraformPlan({
    ...rootArgs(input),
    ...(input.vars ? { vars: input.vars } : {}),
    ...(targets && targets.length > 0 ? { targets } : {}),
    ...lockTimeoutOf(input),
    ...(input.cone && !(targets && targets.length > 0) ? { cone: input.cone } : {}),
    text: false,
  });
  // #4545: the cone's targets join the digest, so an approval of this cone counts for no other.
  const planDigest = conePlanDigest(planned.planDigest, planned.cone);
  const changeSet = planned.changeSet && planDigest !== planned.planDigest ? { ...planned.changeSet, member: { ...planned.changeSet.member, planDigest } } : planned.changeSet;
  // #4545: the plan document beside the plan file, which a wave's cost hold prices.
  const planJson = join(planned.dir, `${planned.planFile}.json`);
  let wrote = true;
  try {
    writeFileSync(planJson, JSON.stringify(planned.json));
  } catch {
    wrote = false;
  }
  return {
    planFile: planned.planFile,
    planDigest,
    ...(wrote ? { planJson } : {}),
    ...(planned.cone ? { cone: planned.cone } : {}),
    ...(changeSet ? { changeSet } : {}),
    json: planned.json,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an `after_unknown` value marks anything unknown: `true`, or `true` anywhere inside. */
function anyUnknown(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(anyUnknown);
  if (isRecord(value)) return Object.values(value).some(anyUnknown);
  return false;
}

/**
 * The outputs a root will have once the plan `json` (`show -json`) applies
 * (#3999). An output is known when `planned_values.outputs` gives its value
 * and its `output_changes` entry marks no part of it unknown after apply.
 * Every other output the plan names is unknown, the whole output even when
 * only a part of it is.
 */
export function terraformPlannedOutputs(json: unknown): PlannedOutputs {
  const doc = isRecord(json) ? json : {};
  const values = isRecord(doc.planned_values) && isRecord(doc.planned_values.outputs) ? doc.planned_values.outputs : {};
  const changes = isRecord(doc.output_changes) ? doc.output_changes : {};
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const name of [...new Set([...Object.keys(values), ...Object.keys(changes)])].sort()) {
    const change = changes[name];
    const planned = values[name];
    if (isRecord(change) && anyUnknown(change.after_unknown)) unknown.push(name);
    else if (isRecord(planned) && "value" in planned) known[name] = planned.value;
    else if (isRecord(change) && "after" in change) known[name] = change.after;
    else unknown.push(name);
  }
  return { known, unknown };
}

/**
 * What a choudoufu member's set plan says about its outputs (#4455), for
 * `member-outputs`: {@link terraformPlannedOutputs} of the embedded plan,
 * chant's digest of that plan, and whether it has changes to apply.
 */
export function choudoufuMemberPlannedOutputs(set: { planDigest: string; changed: boolean; json: unknown }): EnginePlannedOutputs {
  return { ...terraformPlannedOutputs(set.json), planDigest: set.planDigest, changes: set.changed };
}

const memberArgs = (ref: EngineMemberRef) => ({ member: ref.member, dir: ref.dir, projectRoot: ref.workspaceRoot });

/**
 * The choudoufu engine's member outputs (#4455): what core's
 * `member-outputs` reads a workspace member of kind `choudoufu` through.
 * Applied values from the member's root outputs (the record store, for a
 * live estate); planned values from its one-root set plan.
 */
export const choudoufuOutputSource: EngineOutputSource = {
  kinds: ["choudoufu"],
  applied: (_ctx, ref) => choudoufuMemberOutputs(memberArgs(ref)),
  planned: async (_ctx, ref) => choudoufuMemberPlannedOutputs(await choudoufuMemberPlanSet(memberArgs(ref))),
};

const resolvedVars = (input: TerraformApplyStepInput): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input.vars ?? {}).map(([k, v]) => [k, v === undefined ? null : v]));

/**
 * The member of a root whose `vars` read outputs not known yet and that
 * could not be previewed (#3999, #4463): no plan, a hole naming whose outputs
 * it waits on and, when a preview was tried, why it was not possible, and a
 * digest over the root, the vars as resolved and those names.
 */
function waitingRoot(ctx: DeployContext, input: TerraformApplyStepInput, unresolved: string[], noPreview?: string): CapabilityPlan {
  const vars = resolvedVars(input);
  const planDigest = computePlanDigest("terraform-apply-unresolved", { env: ctx.env, root: input.root, vars, unresolved });
  const changeSet: ChangeSetPart = {
    member: {
      member: input.root,
      lexicon: "terraform",
      planner: "chant",
      status: "planned",
      planDigest,
      holes: [waitingHole(input.root, unresolved, noPreview)],
    },
    entries: [],
  };
  return { member: input.root, planDigest, changeSet, ...(ctx.targets?.length ? { targets: ctx.targets } : {}) };
}

/** The plan file a preview writes, removed once it is read: a plan made with stand-ins must never apply. */
export const PREVIEW_PLAN_FILE = ".chant-preview.tfplan";

/** What a previewed root hands `run` (#4463): the shape its plan had with stand-in values. Never a plan file. */
export interface TerraformShapeArtifact extends PlanShapeArtifact {
  kind: "terraform-apply-shape";
}

function isShapeArtifact(value: unknown): value is TerraformShapeArtifact {
  const v = value as Partial<TerraformShapeArtifact> | undefined;
  return v?.kind === "terraform-apply-shape" && typeof v.digest === "string" && typeof v.shape === "object" && v.shape !== null;
}

/** The root's directory, as `terraform.roots` names it from the nearest `chant.config.*`, and the configured binary. */
async function rootDir(input: TerraformApplyStepInput): Promise<{ dir: string; binary?: string } | undefined> {
  const start = resolve(input.cwd ?? process.cwd());
  const { config, configPath } = await loadChantConfigUpward(start);
  const terraform = (config as { terraform?: TerraformConfig }).terraform;
  const declared = terraform?.roots?.[input.root]?.dir;
  if (declared === undefined) return undefined;
  const dir = input.dir ?? declared;
  return { dir: resolve(configPath ? dirname(configPath) : start, dir), ...(terraform?.binary ? { binary: terraform.binary } : {}) };
}

const firstLines = (err: unknown): string => {
  const text = (err instanceof Error ? err.message : String(err)).trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 4).join(" ").slice(0, 600);
};

/**
 * Preview a root whose `vars` read outputs not known yet (#4463): plan it
 * with a typed stand-in per such variable, mark what the stand-ins drive
 * unknown, and answer the change set, the planned outputs and the shape of
 * that plan, with the shape as the artifact. The plan file is removed. When
 * no preview can be made, the member stays a hole saying why.
 */
async function previewRoot(ctx: DeployContext, input: TerraformApplyStepInput, unresolved: string[], targets?: string[]): Promise<CapabilityPlan> {
  const root = await rootDir(input);
  if (root === undefined) return waitingRoot(ctx, input, unresolved, `no root named "${input.root}" in terraform.roots to read its variables from`);
  const { dir } = root;
  // #4457: the same files the binary reads (`.tofu` only for tofu and choudoufu).
  const stand = placeholderVars(input.vars, declaredVariables(rootTexts(dir, root.binary)));
  if (typeof stand === "string") return waitingRoot(ctx, input, unresolved, stand);
  let planned: Awaited<ReturnType<typeof terraformPlan>>;
  try {
    await terraformInit(rootArgs(input));
    planned = await terraformPlan({
      ...rootArgs(input),
      vars: stand.vars,
      planFile: PREVIEW_PLAN_FILE,
      ...(targets ? { targets } : {}),
      text: false,
    });
  } catch (err) {
    return waitingRoot(ctx, input, unresolved, `the plan with stand-in values failed: ${firstLines(err)}`);
  } finally {
    rmSync(join(dir, PREVIEW_PLAN_FILE), { force: true });
  }
  const marked = markPlaceholderDriven(planned.json, stand.placeholders);
  if ("refused" in marked) return waitingRoot(ctx, input, unresolved, marked.refused);
  const placeholders = stand.placeholders.map((name) => `var.${name}`);
  const shape = terraformPlanShape(marked.plan, input.root, { unknownInputs: unresolved });
  const artifact: TerraformShapeArtifact = { kind: "terraform-apply-shape", member: input.root, shape, digest: planShapeDigest(shape) };
  const part = terraformChangeSetPart({
    member: input.root,
    plan: marked.plan,
    ...(planned.changeSet?.member.planner ? { planner: planned.changeSet.member.planner } : {}),
    ...(planned.changeSet?.member.scope ? { scope: planned.changeSet.member.scope } : {}),
  });
  // The stand-ins' values are not real, so the digest is over the preview's shape and entries, never the raw plan.
  const planDigest = computePlanDigest("terraform-apply-preview", {
    env: ctx.env,
    root: input.root,
    vars: resolvedVars(input),
    unresolved,
    placeholders,
    shape: artifact.digest,
    entries: part.entries,
  });
  const changeSet: ChangeSetPart = { ...part, member: { ...part.member, planDigest, placeholders } };
  return {
    member: input.root,
    planDigest,
    artifact,
    changeSet,
    outputs: terraformPlannedOutputs(marked.plan),
    shape,
    ...(targets ? { targets } : {}),
  };
}

/**
 * choudoufu refused the plan `run` was handed by its wave (its exit 3)
 * because the live system moved since the plan. Nothing was applied.
 * `planMoved` is core's mark for a moved plan (`isPlanMovedError`), so the
 * command that applied it exits `CHANT_EXIT.moved`, 4, as for the other
 * capabilities that refuse a moved plan (#3997, #4553). A plan made against
 * another estate is a plain failure (`terraformExitOf` in ../exit-codes).
 */
export class TerraformPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(public readonly root: string, message: string) {
    super(message);
    this.name = "TerraformPlanMovedError";
  }
}

function isPlannedRoot(value: unknown): value is PlannedRoot {
  const v = value as Partial<PlannedRoot> | undefined;
  return typeof v?.planFile === "string" && typeof v.planDigest === "string";
}

/** What `plan` hands `run` for a choudoufu root planned as a one-root set (#3459). */
interface ChoudoufuWavePlannedRoot {
  planDigest: string;
  choudoufu: { planSetFile: string; setDigest: string };
  /** The root's rows on the resource lock grain (#4552), from its embedded plan. */
  lockRows?: LockRow[];
}

function isChoudoufuWavePlan(value: unknown): value is ChoudoufuWavePlannedRoot {
  const v = value as Partial<ChoudoufuWavePlannedRoot> | undefined;
  return (
    typeof v?.planDigest === "string" &&
    typeof v.choudoufu?.planSetFile === "string" &&
    typeof v.choudoufu.setDigest === "string"
  );
}

/** Apply a choudoufu root through `live-wave-apply`, carrying its resume file either way. */
async function runChoudoufuWave(
  ctx: DeployContext,
  input: TerraformApplyStepInput,
  planned: ChoudoufuWavePlannedRoot,
): Promise<TerraformApplyStepOutput> {
  const applied = await choudoufuWaveApply({
    ...rootArgs(input),
    planSetFile: planned.choudoufu.planSetFile,
    setDigest: planned.choudoufu.setDigest,
    ...(ctx.carried?.[input.root] !== undefined ? { carried: ctx.carried[input.root] } : {}),
  });
  if (applied.carry) ctx.carry?.(input.root, applied.carry);
  if (!applied.landed) {
    const message = `terraform-apply: root "${input.root}": ${applied.message}`;
    if (terraformPlanMoved({ command: "live-wave-apply", code: applied.exitCode })) throw new TerraformPlanMovedError(input.root, message);
    throw new Error(message);
  }
  const outputs = await terraformOutputs(rootArgs(input));
  return { root: input.root, planDigest: planned.planDigest, fromWavePlan: true, outputs };
}

/** The input a `run` that plans for itself plans with (#4545): its reads filled, or an error naming the upstream to apply first. */
async function readsForRun(input: TerraformApplyStepInput): Promise<TerraformApplyStepInput> {
  const read = await withReads(input);
  if ("waiting" in read) throw new Error(`terraform-apply: root "${input.root}": ${read.waiting}`);
  return read.input;
}

/** The engine a root plans with (#4552): the configured binary's, else the plan's planner. */
async function plannerOf(input: TerraformApplyStepInput, plan?: CapabilityPlan): Promise<"terraform" | "tofu" | "choudoufu" | undefined> {
  const binary = (await rootDir(input).catch(() => undefined))?.binary;
  if (binary !== undefined) return plannerForBinary(binary) as "terraform" | "tofu" | "choudoufu";
  const planner = plan?.changeSet?.member.planner;
  return planner === "terraform" || planner === "tofu" || planner === "choudoufu" ? planner : "terraform";
}

export const terraformApplyCapability: Capability<TerraformApplyStepInput, TerraformApplyStepOutput> = {
  kind: "terraform-apply",
  // A root's apply has no undo short of applying the previous configuration,
  // which is a change of its own. COMP003 asks the component to say so.
  rollbackPolicy: "needs-opt-out",
  // #4300: `--target` passes through as `-target`, and the saved plan holds those addresses alone.
  targets: "accept",
  // #4627: `plan` refreshes the root's state before it plans unless told `-refresh=false`, which chant never passes,
  // so `--refresh` asks for what every plan does and the digest still binds it. `-target` plans a resource with what it
  // depends on and never what depends on it, so `--target-dependents` has nothing to map onto.
  planFlags: {
    refresh: "accept",
    targetDependents: { refuse: "terraform and tofu plan a -target with what it depends on, never what depends on it, so there is no flag to widen it to its dependents; name each dependent with --target" },
  },
  async plan(ctx: DeployContext, given: TerraformApplyStepInput): Promise<CapabilityPlan> {
    requireRoot(given);
    // #4545: a root reading an upstream's output that is not there yet is a hole naming the upstream.
    const read = await withReads(given);
    if ("waiting" in read) return waitingOnReads(ctx, given, read);
    const { input } = read;
    const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
    const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
    if (unresolved.length > 0) return previewRoot(ctx, input, unresolved, targets);
    // A targeted root plans with `plan -target`, and a cone plan with `plan -cone` (#4545), never as a choudoufu one-root set.
    const wave = targets || input.cone ? { wave: false } : await choudoufuWaveRoot({ ...rootArgs(input), ...(input.vars ? { vars: input.vars } : {}) });
    if (wave.wave) {
      const set = await choudoufuPlanSet(rootArgs(input));
      const artifact: ChoudoufuWavePlannedRoot = {
        planDigest: set.planDigest,
        choudoufu: { planSetFile: set.planSetFile, setDigest: set.setDigest },
        lockRows: terraformLockRows(input.root, set.changeSet.member.scope, set.json),
      };
      return { member: input.root, planDigest: set.planDigest, artifact, changeSet: set.changeSet, outputs: terraformPlannedOutputs(set.json), shape: terraformPlanShape(set.json, input.root) };
    }
    const { changeSet, json, ...planned } = await planRoot(input, targets);
    // #4552: a choudoufu root's rows, keyed from the plan document while it is at hand.
    const lockRows = changeSet?.member.planner === "choudoufu" ? terraformLockRows(input.root, changeSet.member.scope, json) : undefined;
    return {
      member: input.root,
      planDigest: planned.planDigest,
      artifact: { ...planned, ...(lockRows ? { lockRows } : {}) },
      ...(changeSet ? { changeSet } : {}),
      outputs: terraformPlannedOutputs(json),
      shape: terraformPlanShape(json, input.root),
      ...(targets ? { targets } : {}),
    };
  },
  // The root's outputs as its state holds them now (#3183): what a dependent
  // planned before this root applies reads through `stackOutput()`.
  async outputs(_ctx: DeployContext, input: TerraformApplyStepInput): Promise<Record<string, unknown>> {
    requireRoot(input);
    await terraformInit(rootArgs(input));
    return terraformOutputs(rootArgs(input));
  },
  // #4447 (ws-107): a group core forms of components that read each other plans and applies as one composed run
  // when `terraform.compose.enabled` is set (./compose-group.ts). Delegates, so the methods are read when called.
  groupReads: (ctx, members) => terraformComposeGroup.groupReads(ctx, members),
  // #4542: a member pointed at a release's recorded copy plans alone, since a composition reads the declared roots.
  groupFallback: async (ctx, members) =>
    members.some((m) => typeof m.step.dir === "string")
      ? { kind: "release-copy", reason: "a member deploys a release's recorded copy of its root, which a composition does not read" }
      : terraformComposeGroup.groupFallback(ctx, members),
  // #4542: the root's files, which a release cut records and a promote under it plans.
  releaseInputs: (input, ctx) => terraformReleaseInputs(input, ctx),
  // #4552: resource under choudoufu, the root under Terraform, tofu and Terragrunt, which refuse resource by name.
  async defaultLockGrain(input, plan) {
    return terraformDefaultLockGrain(await plannerOf(input, plan));
  },
  async lockGrainRefusal(input, grain, plan) {
    if (grain !== "resource") return undefined;
    const binary = (await rootDir(input).catch(() => undefined))?.binary;
    return terraformLockGrainRefusal(grain, await plannerOf(input, plan), binary);
  },
  lockRows(input, plan) {
    const kept = (plan.artifact as { lockRows?: LockRow[] } | undefined)?.lockRows;
    if (Array.isArray(kept)) return kept;
    return plan.changeSet ? terraformLockRowsFromPart(input.root, plan.changeSet) : [];
  },
  // #4555: the root and the binary, for the step's span and run record.
  traceFacts: async (input, outcome) => terraformTraceFacts(input, outcome, (await rootDir(input).catch(() => undefined))?.binary),
  planGroup: (ctx, members) => terraformComposeGroup.planGroup(ctx, members),
  runGroup: (ctx, run, members) => terraformComposeGroup.runGroup(ctx, run, members),
  async run(ctx: DeployContext, input: TerraformApplyStepInput): Promise<TerraformApplyStepOutput> {
    const fromWave = ctx.plans?.[input.root];
    if (isChoudoufuWavePlan(fromWave)) return runChoudoufuWave(ctx, input, fromWave);
    if (isShapeArtifact(fromWave)) {
      // A root previewed with stand-ins (#4463): plan it now with the real
      // values, and apply that plan only when it is within the preview's shape.
      const fresh = await planRoot(await readsForRun(input), ctx.targets);
      const differences = planShapeDifferences(fromWave.shape, terraformPlanShape(fresh.json, input.root));
      if (differences.length > 0) throw new PlanShapeMovedError(input.root, differences);
      const applied = await terraformApply({ ...rootArgs(input), planFile: fresh.planFile, ...lockTimeoutOf(input) });
      if (!applied.applied) {
        throw new Error(`terraform-apply: root "${input.root}" refused the plan it was given (${applied.refused ?? "refused"}). ${applied.refusal ?? ""}`);
      }
      const outputs = await terraformOutputs(rootArgs(input));
      return { root: input.root, planDigest: fresh.planDigest, fromWavePlan: false, outputs };
    }
    const planned: PlannedRoot = isPlannedRoot(fromWave)
      ? fromWave
      : await planRoot(await readsForRun(input), ctx.targets).then(({ planFile, planDigest }) => ({ planFile, planDigest }));
    const applied = await terraformApply({ ...rootArgs(input), planFile: planned.planFile, ...lockTimeoutOf(input) });
    if (!applied.applied) {
      const message =
        `terraform-apply: root "${input.root}" refused the plan it was given (${applied.refused ?? "refused"}). ` +
        (applied.refusal ?? "");
      // A plan the wave approved that choudoufu refuses as no longer matching
      // moved since the approval (#4553: one made against another estate is a
      // failure). One this run made itself is planned afresh by the next run.
      if (applied.refused === "approval-mismatch" && isPlannedRoot(fromWave)) throw new TerraformPlanMovedError(input.root, message);
      throw new Error(message);
    }
    const outputs = await terraformOutputs(rootArgs(input));
    return { root: input.root, planDigest: planned.planDigest, fromWavePlan: isPlannedRoot(fromWave), outputs };
  },
};

export const TERRAFORM_VERB_FAMILIES = {
  apply: ["terraform-apply"],
  // #4618: the binary runs outside waves, each a fixed operation; the two that change state on their own run under a gated request.
  state: ["terraform-state-unlock", "terraform-state-push"],
  copy: ["terraform-copy"],
  // #4653: one action block invoked on its own, under a gated request.
  action: ["terraform-action"],
} as const;

export const terraformCapabilityPlugin: CapabilityPlugin = {
  name: "terraform",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [terraformApplyCapability as Capability<never, unknown>, ...terraformStateOpCapabilities.map((c) => c as unknown as Capability<never, unknown>), terraformActionCapability as unknown as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return TERRAFORM_VERB_FAMILIES;
  },
  engineOutputSources(): EngineOutputSource[] {
    return [choudoufuOutputSource];
  },
};
