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
 * that applied it exits 3 (#3997). terraform's and tofu's stale-plan error
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
 * is not planned: terraform takes no unknown variable. Its member gets a hole
 * naming the roots it waits on and no artifact, and the run that applies it
 * plans it once their outputs are known.
 *
 * ## The plan's shape (#4436)
 *
 * `plan` also answers `shape`, `terraformPlanShape` over `show -json`: each
 * resource the plan changes with its action, type, replacement, the
 * attributes that differ and the ones unknown after apply. Core's
 * `coveredRound` compares it with the shape of a later plan of the root. A
 * root waiting on outputs not known yet has no plan, so no shape, and stays
 * uncovered.
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
 * output is not a hole: the apply passes the value on. `groupFallback`,
 * `planGroup` and `runGroup` are in `./compose-group.ts`.
 */

import type { Capability, DeployContext, CapabilityPlan, PlannedOutputs } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import {
  choudoufuPlanSet,
  choudoufuWaveApply,
  choudoufuWaveRoot,
  terraformApply,
  terraformInit,
  terraformOutputs,
  terraformPlan,
} from "../op/activities/terraform";
import { terraformPlanShape } from "../plan-shape";
import { terraformComposeGroup } from "./compose-group";

/** The `terraform-apply` step's input. */
export interface TerraformApplyStepInput {
  /** Key into `terraform.roots`. Also the member's name in a wave's set digest. */
  root: string;
  /** Input variables, after the root's var files. See `TerraformPlanArgs.vars`. */
  vars?: Record<string, unknown>;
  /** Where the `chant.config.*` search starts. Default: the current directory. */
  cwd?: string;
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
}

const rootArgs = (input: TerraformApplyStepInput) => ({ root: input.root, ...(input.cwd ? { cwd: input.cwd } : {}) });

function requireRoot(input: TerraformApplyStepInput): void {
  if (typeof input.root !== "string" || input.root === "") {
    throw new Error('terraform-apply: "root" is required and names an entry in terraform.roots');
  }
}

async function planRoot(input: TerraformApplyStepInput, targets?: string[]): Promise<PlannedRoot & { changeSet?: ChangeSetPart; json?: unknown }> {
  requireRoot(input);
  await terraformInit(rootArgs(input));
  const planned = await terraformPlan({
    ...rootArgs(input),
    ...(input.vars ? { vars: input.vars } : {}),
    ...(targets && targets.length > 0 ? { targets } : {}),
  });
  return {
    planFile: planned.planFile,
    planDigest: planned.planDigest,
    ...(planned.changeSet ? { changeSet: planned.changeSet } : {}),
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
 * The member of a root whose `vars` read outputs not known yet (#3999): no
 * plan, a hole naming whose outputs it waits on, and a digest over the root,
 * the vars as resolved and those names.
 */
function waitingRoot(ctx: DeployContext, input: TerraformApplyStepInput, unresolved: string[]): CapabilityPlan {
  const vars = Object.fromEntries(Object.entries(input.vars ?? {}).map(([k, v]) => [k, v === undefined ? null : v]));
  const planDigest = computePlanDigest("terraform-apply-unresolved", { env: ctx.env, root: input.root, vars, unresolved });
  const changeSet: ChangeSetPart = {
    member: {
      member: input.root,
      lexicon: "terraform",
      planner: "chant",
      status: "planned",
      planDigest,
      holes: [{ address: input.root, type: "terraform_root", reason: `inputs from ${unresolved.join(", ")}; planned again once they apply` }],
    },
    entries: [],
  };
  return { member: input.root, planDigest, changeSet, ...(ctx.targets?.length ? { targets: ctx.targets } : {}) };
}

/**
 * choudoufu refused the plan `run` was handed by its wave (its exit 3):
 * the live system moved since the plan, or the plan names another estate.
 * Nothing was applied. `planMoved` is core's mark for a moved plan
 * (`isPlanMovedError`), so the command that applied it exits 3, as for the
 * other capabilities that refuse a moved plan (#3997).
 */
export class TerraformPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(public readonly root: string, message: string) {
    super(message);
    this.name = "TerraformPlanMovedError";
  }
}

/** `live-wave-apply`'s exit status for a set whose plan moved (`CHOUDOUFU_WAVE_EXIT.setMoved`). */
const CHOUDOUFU_SET_MOVED_EXIT = 3;

function isPlannedRoot(value: unknown): value is PlannedRoot {
  const v = value as Partial<PlannedRoot> | undefined;
  return typeof v?.planFile === "string" && typeof v.planDigest === "string";
}

/** What `plan` hands `run` for a choudoufu root planned as a one-root set (#3459). */
interface ChoudoufuWavePlannedRoot {
  planDigest: string;
  choudoufu: { planSetFile: string; setDigest: string };
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
    if (applied.exitCode === CHOUDOUFU_SET_MOVED_EXIT) throw new TerraformPlanMovedError(input.root, message);
    throw new Error(message);
  }
  const outputs = await terraformOutputs(rootArgs(input));
  return { root: input.root, planDigest: planned.planDigest, fromWavePlan: true, outputs };
}

export const terraformApplyCapability: Capability<TerraformApplyStepInput, TerraformApplyStepOutput> = {
  kind: "terraform-apply",
  // A root's apply has no undo short of applying the previous configuration,
  // which is a change of its own. COMP003 asks the component to say so.
  rollbackPolicy: "needs-opt-out",
  // #4300: `--target` passes through as `-target`, and the saved plan holds those addresses alone.
  targets: "accept",
  async plan(ctx: DeployContext, input: TerraformApplyStepInput): Promise<CapabilityPlan> {
    requireRoot(input);
    const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
    if (unresolved.length > 0) return waitingRoot(ctx, input, unresolved);
    const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
    // A targeted root plans with `plan -target`, never as a choudoufu one-root set.
    const wave = targets ? { wave: false } : await choudoufuWaveRoot({ ...rootArgs(input), ...(input.vars ? { vars: input.vars } : {}) });
    if (wave.wave) {
      const set = await choudoufuPlanSet(rootArgs(input));
      const artifact: ChoudoufuWavePlannedRoot = {
        planDigest: set.planDigest,
        choudoufu: { planSetFile: set.planSetFile, setDigest: set.setDigest },
      };
      return { member: input.root, planDigest: set.planDigest, artifact, changeSet: set.changeSet, outputs: terraformPlannedOutputs(set.json), shape: terraformPlanShape(set.json, input.root) };
    }
    const { changeSet, json, ...planned } = await planRoot(input, targets);
    return {
      member: input.root,
      planDigest: planned.planDigest,
      artifact: planned,
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
  groupFallback: (ctx, members) => terraformComposeGroup.groupFallback(ctx, members),
  planGroup: (ctx, members) => terraformComposeGroup.planGroup(ctx, members),
  runGroup: (ctx, run, members) => terraformComposeGroup.runGroup(ctx, run, members),
  async run(ctx: DeployContext, input: TerraformApplyStepInput): Promise<TerraformApplyStepOutput> {
    const fromWave = ctx.plans?.[input.root];
    if (isChoudoufuWavePlan(fromWave)) return runChoudoufuWave(ctx, input, fromWave);
    const planned: PlannedRoot = isPlannedRoot(fromWave)
      ? fromWave
      : await planRoot(input, ctx.targets).then(({ planFile, planDigest }) => ({ planFile, planDigest }));
    const applied = await terraformApply({ ...rootArgs(input), planFile: planned.planFile });
    if (!applied.applied) {
      const message =
        `terraform-apply: root "${input.root}" refused the plan it was given (${applied.refused ?? "refused"}). ` +
        (applied.refusal ?? "");
      // A plan the wave approved that choudoufu refuses moved since the
      // approval. One this run made itself is planned afresh by the next run.
      if (applied.refused !== undefined && isPlannedRoot(fromWave)) throw new TerraformPlanMovedError(input.root, message);
      throw new Error(message);
    }
    const outputs = await terraformOutputs(rootArgs(input));
    return { root: input.root, planDigest: planned.planDigest, fromWavePlan: isPlannedRoot(fromWave), outputs };
  },
};

export const TERRAFORM_VERB_FAMILIES = {
  apply: ["terraform-apply"],
} as const;

export const terraformCapabilityPlugin: CapabilityPlugin = {
  name: "terraform",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [terraformApplyCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return TERRAFORM_VERB_FAMILIES;
  },
};
