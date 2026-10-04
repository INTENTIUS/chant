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
 * #878). Either refusal fails the step.
 *
 * Run without a wave plan (`chant run --components`, or a fan-out with no
 * wave gate), `run` plans and applies in one go, which is what `terraform
 * apply` with no plan file does too.
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
 */

import type { Capability, DeployContext, CapabilityPlan } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
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

async function planRoot(input: TerraformApplyStepInput): Promise<PlannedRoot & { changeSet?: ChangeSetPart }> {
  requireRoot(input);
  await terraformInit(rootArgs(input));
  const planned = await terraformPlan({ ...rootArgs(input), ...(input.vars ? { vars: input.vars } : {}) });
  return {
    planFile: planned.planFile,
    planDigest: planned.planDigest,
    ...(planned.changeSet ? { changeSet: planned.changeSet } : {}),
  };
}

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
    throw new Error(`terraform-apply: root "${input.root}": ${applied.message}`);
  }
  const outputs = await terraformOutputs(rootArgs(input));
  return { root: input.root, planDigest: planned.planDigest, fromWavePlan: true, outputs };
}

export const terraformApplyCapability: Capability<TerraformApplyStepInput, TerraformApplyStepOutput> = {
  kind: "terraform-apply",
  // A root's apply has no undo short of applying the previous configuration,
  // which is a change of its own. COMP003 asks the component to say so.
  rollbackPolicy: "needs-opt-out",
  async plan(_ctx: DeployContext, input: TerraformApplyStepInput): Promise<CapabilityPlan> {
    requireRoot(input);
    const wave = await choudoufuWaveRoot({ ...rootArgs(input), ...(input.vars ? { vars: input.vars } : {}) });
    if (wave.wave) {
      const set = await choudoufuPlanSet(rootArgs(input));
      const artifact: ChoudoufuWavePlannedRoot = {
        planDigest: set.planDigest,
        choudoufu: { planSetFile: set.planSetFile, setDigest: set.setDigest },
      };
      return { member: input.root, planDigest: set.planDigest, artifact, changeSet: set.changeSet };
    }
    const { changeSet, ...planned } = await planRoot(input);
    return { member: input.root, planDigest: planned.planDigest, artifact: planned, ...(changeSet ? { changeSet } : {}) };
  },
  // The root's outputs as its state holds them now (#3183): what a dependent
  // planned before this root applies reads through `stackOutput()`.
  async outputs(_ctx: DeployContext, input: TerraformApplyStepInput): Promise<Record<string, unknown>> {
    requireRoot(input);
    await terraformInit(rootArgs(input));
    return terraformOutputs(rootArgs(input));
  },
  async run(ctx: DeployContext, input: TerraformApplyStepInput): Promise<TerraformApplyStepOutput> {
    const fromWave = ctx.plans?.[input.root];
    if (isChoudoufuWavePlan(fromWave)) return runChoudoufuWave(ctx, input, fromWave);
    const planned: PlannedRoot = isPlannedRoot(fromWave) ? fromWave : await planRoot(input);
    const applied = await terraformApply({ ...rootArgs(input), planFile: planned.planFile });
    if (!applied.applied) {
      throw new Error(
        `terraform-apply: root "${input.root}" refused the plan it was given (${applied.refused ?? "refused"}). ` +
          (applied.refusal ?? ""),
      );
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
