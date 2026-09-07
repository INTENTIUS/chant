/**
 * TerraformWatchOp composite (#2087): drift reporting for one root module,
 * on a schedule.
 *
 * The observe position on the lifecycle dial. `TerraformApplyOp` next door
 * changes the estate; this one never does: it inits, plans, and reports what
 * the plan found. `terraform plan -detailed-exitcode` is the whole mechanism.
 * Exit 0 is "the world matches the configuration", exit 2 is drift, and
 * `terraformPlan` turns that into the boolean `changed`, which rides out of
 * the Op as the run's `Drift` outcome.
 *
 * Phases: Init, Plan, and (for a finding mode that opens something) Report.
 *
 * ## Only the human plan is ever posted
 *
 * `terraformPlan` returns two renders of the same plan: `json`, from
 * `terraform show -json`, and `text`, from `terraform show -no-color`. The
 * JSON one carries every resource attribute value the plan touches, including
 * provider credentials that no `sensitive` marking covers, because
 * `sensitive_values` describes the configuration's own declarations rather
 * than everything a provider puts in a plan. So the issue and pull-request
 * modes reference `plan.out.text` and nothing else. There is no option to
 * post the JSON, and `terraform-watch-op.test.ts` asserts no reference to it
 * reaches the finding step.
 *
 * The same rule holds on a live root, where the JSON is choudoufu's own
 * bound/omissions/unowned document rather than a plan representation, and
 * carries live identities and tag values for every resource the estate
 * touched. `choudoufuLivePlan` composes the plan text and the adoption ledger
 * into one `finding` string for exactly this reason: the body is one
 * reference to one text field, so there is no arrangement of the args in
 * which the document reaches a body.
 *
 * ## A live root reports three things, not one (#2105)
 *
 * `live: true` swaps the Plan step for `choudoufuLivePlan`. On a choudoufu
 * root ownership is a pair of tags on the resource rather than an entry in a
 * state file, so a plan against the live system can answer three questions
 * where a stock plan answers one: whether the estate drifted (the
 * `-detailed-exitcode` exit, `Drift` as before), how many live resources sit
 * at a declared identity carrying no marker (`Unowned`), and how many of those
 * an exact content match makes claimable (`Adoptable`). All three come off a
 * single live read, published as three run outcomes from the one step.
 *
 * The finding modes then carry the adoption ledger under the plan text: one
 * line per adoptable match with its address, its live identity and the
 * `tofu-estate`/`tofu-address` values that claim it, in the row form
 * `live-plan -adoption-only` prints, followed by any contested address. That
 * is a report, not an action. `TerraformAdoptOp` next door is what writes the
 * markers, and it gates first.
 *
 * ## Findings reuse `reconcilePr`
 *
 * `issue` and `pull-request` call core's `reconcilePr` activity, the one place
 * in chant that shells to `gh issue create` / `gh pr create`, rather than
 * growing a second copy of those calls here.
 * That activity built its own change-set summary and had no way to be handed
 * one, so #2087 added a single field to it (`ReconcilePrArgs.body`), which is
 * what carries the `-no-color` plan through. Note that the pull-request mode
 * of `reconcilePr` regenerates chant TypeScript via `chant import`; a
 * terraform-native regeneration of HCL from live state is #2089, so
 * `findingMode: "issue"` is the mode with an end-to-end answer and
 * `"pull-request"` opens a PR whose body is the plan. On a live root #2089's
 * question has a different answer rather than a pending one, and it is not
 * regeneration: see `TerraformAdoptOp`.
 *
 * ## The schedule
 *
 * A cron lands on the Op itself as `schedule` (#2120), the same field
 * `WatchOp` and `ConvergeOp` set. It is runtime-neutral data: `chant
 * operator` reads it as this Op's tick cadence, `generateOpsPipeline` against
 * the github lexicon renders it as a CI cron, and a hosting lexicon hands it
 * to its own scheduler. The one-shot `chant run app-watch` path ignores it.
 * `examples/scheduled-watch/` is the CI recipe.
 *
 * @example
 * ```typescript
 * import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";
 *
 * // one-shot, local executor: chant run app-watch
 * export const { op } = TerraformWatchOp({ name: "app-watch", root: "app" });
 *
 * // nightly, opening an issue when the plan is non-empty
 * export const { op } = TerraformWatchOp({
 *   name: "app-watch",
 *   root: "app",
 *   schedule: "0 6 * * *",
 *   findingMode: "issue",
 * });
 *
 * // a choudoufu estate: drift, unowned and adoptable, with the ledger in the issue
 * export const { op } = TerraformWatchOp({
 *   name: "estate-watch",
 *   root: "estate",
 *   live: true,
 *   findingMode: "issue",
 * });
 * ```
 */

import { Op, phase, OpResource, type ActivityStep } from "@intentius/chant/op";
import { CHOUDOUFU_LIVE_PLAN_OUT_REFUSAL, DEFAULT_PLAN_FILE } from "../op/activities/terraform";
import {
  terraformInit as initStep,
  terraformPlan as planStep,
  choudoufuLivePlan as livePlanStep,
} from "../op/builders";

/**
 * What to do with a non-empty plan. A subset of core's `OpFindingMode`
 * (`packages/core/src/lexicon.ts`): `merge-request` is GitLab's spelling of
 * `pull-request` and is produced by the CI generator, not chosen here.
 */
export type TerraformFindingMode = "report" | "issue" | "pull-request";

export interface TerraformWatchOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** Key into the project's `terraform.roots`. The root carries dir, workspace, var files and backend config. */
  root: string;
  /**
   * Cron expression. When set, it lands on the Op as `schedule` — the cadence
   * `chant operator` ticks on and `generateOpsPipeline` renders as a CI cron.
   * Omit for one-shot `chant run` on the local executor.
   */
  schedule?: string;
  /**
   * What to do when the plan proposes changes. Default: `"report"`, which
   * opens nothing. The `Drift` run outcome and the run's own log are
   * the report.
   */
  findingMode?: TerraformFindingMode;
  /**
   * Watch a live root (#2105): the root runs `terraform.binary: "choudoufu"`
   * and declares an estate, so the Plan phase is `choudoufuLivePlan` rather
   * than `terraformPlan`. See the module doc for what changes.
   *
   * Declared here rather than detected, because a composite is built by
   * `chant build` without reading a root module's `.tf` files. The activities
   * detect the estate at run time (`op/activities/live-detect.ts`), but by then
   * the phases are already serialized. Setting this on a stock root fails at
   * the first step, with choudoufu's own reason.
   */
  live?: boolean;
  /**
   * The estate to plan against, for a live root whose estate this Op should
   * name explicitly. Omitted, `choudoufuLivePlan` auto-detects it from the
   * root's own `live` block or `estate.chdf.hcl` sidecar, which is the usual
   * case. Refused on a stock root.
   */
  estate?: string;
  /**
   * Plan file the Plan step writes, relative to the root dir. Default:
   * `chant.tfplan`. Refused on a live root, where choudoufu takes no plan file
   * at all.
   */
  planFile?: string;
  /** `-upgrade` on the Init step: re-resolve provider and module versions. */
  upgrade?: boolean;
  /**
   * Directory each step starts the `chant.config.*` search from, which is
   * what `terraform.roots` and the root's relative `dir` resolve against.
   * Default: the running process's cwd, which is the project root under
   * `chant run`. Same field, same meaning, as `TerraformApplyOpConfig.cwd`.
   */
  cwd?: string;
  /** Issue / PR title. Default: `Terraform drift in root "<root>"`. */
  title?: string;
  /** Branch the pull-request mode opens from. Default: `reconcilePr`'s own. */
  branch?: string;
}

export interface TerraformWatchOpResources {
  /** Op resource. Generates the Init/Plan/[Report] phases. */
  op: InstanceType<typeof OpResource>;
}

export function TerraformWatchOp(config: TerraformWatchOpConfig): TerraformWatchOpResources {
  const findingMode: TerraformFindingMode = config.findingMode ?? "report";
  const where = config.cwd ? { cwd: config.cwd } : {};

  if (config.live && config.planFile !== undefined) {
    throw new Error(
      `TerraformWatchOp "${config.name}": planFile is refused on a live root. choudoufu: ` +
        `"${CHOUDOUFU_LIVE_PLAN_OUT_REFUSAL}". A live plan writes no saved plan, so there is no file to name; ` +
        "drop planFile, or drop live if this root runs stock.",
    );
  }
  if (!config.live && config.estate !== undefined) {
    throw new Error(
      `TerraformWatchOp "${config.name}": estate names the estate a live plan looks for markers of, and ` +
        "this Op is not on a live root. Set live: true, or drop estate.",
    );
  }

  // `id` is what makes `plan.out` legal, and one field of `plan.out` is the
  // only channel by which any part of the plan leaves this Op.
  //
  // A live root reads the live system instead of a state file, so the three
  // things a watch reports come off one `choudoufuLivePlan`: `drift` from
  // `-detailed-exitcode`, and `unowned`/`adoptable` from the `-json` document
  // the same run wrote. Three attributes, one live read: see
  // `ActivityStep.outcomeAttribute`'s array form (#2105).
  const plan = config.live
    ? livePlanStep(config.root, { ...where, ...(config.estate ? { estate: config.estate } : {}), id: "plan" })
    : planStep(config.root, { planFile: config.planFile ?? DEFAULT_PLAN_FILE, ...where, id: "plan" });
  plan.outcomeAttribute = config.live
    ? [
        { name: "Drift", from: "drift" },
        { name: "Unowned", from: "unowned" },
        { name: "Adoptable", from: "adoptable" },
      ]
    : { name: "Drift", from: "changed" };

  const phases = [
    phase("Init", [initStep(config.root, { ...where, ...(config.upgrade ? { upgrade: true } : {}) })]),
    phase("Plan", [plan]),
  ];

  if (findingMode !== "report") {
    // `env` is `reconcilePr`'s name for the thing being reconciled; for
    // terraform that is the root, which with its workspace is the deployment
    // target. `entries: []` and `body` together mean the activity opens what
    // it is given rather than running `chant lifecycle plan` to find out.
    const report: ActivityStep = {
      kind: "activity",
      fn: "reconcilePr",
      args: {
        env: config.root,
        mode: findingMode,
        entries: [],
        title: config.title ?? `Terraform drift in root "${config.root}"`,
        // Stock: the `-no-color` plan. Live: the same plan text with the
        // adoption ledger under it, which `choudoufuLivePlan` composes into
        // one `finding` field precisely so that a body is one reference and
        // the `-json` document has no path into one at all.
        body: config.live ? plan.out.finding : plan.out.text,
        ...(config.branch ? { branch: config.branch } : {}),
      },
      outcomeAttribute:
        findingMode === "pull-request" ? { name: "PR", from: "prUrl" } : { name: "Issue", from: "issueUrl" },
    };
    phases.push(phase("Report", [report]));
  }

  const op = Op({
    name: config.name,
    overview: config.live
      ? `Live-plan the "${config.root}" choudoufu estate and report drift, unowned and adoptable resources`
      : `Plan the "${config.root}" terraform root and report drift`,
    labels: {
      Watch: "true",
      TerraformRoot: config.root,
      ...(config.live ? { TerraformMode: "live" } : {}),
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases,
  });

  return { op };
}
