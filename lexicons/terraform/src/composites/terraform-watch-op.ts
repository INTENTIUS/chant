/**
 * TerraformWatchOp composite (#2087): drift reporting for one root module,
 * on a schedule.
 *
 * The observe position on the lifecycle dial. `TerraformApplyOp` next door
 * changes the estate; this one never does: it inits, plans, and reports what
 * the plan found. `terraform plan -detailed-exitcode` is the whole mechanism.
 * Exit 0 is "the world matches the configuration", exit 2 is drift, and
 * `terraformPlan` turns that into the boolean `changed`, which rides out of
 * the Op as the `Drift` search attribute.
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
 * ## Findings reuse `reconcilePr`
 *
 * `issue` and `pull-request` call the temporal lexicon's `reconcilePr`
 * activity, the one place in chant that shells to `gh issue create` /
 * `gh pr create`, rather than growing a second copy of those calls here.
 * That activity built its own change-set summary and had no way to be handed
 * one, so #2087 added a single field to it (`ReconcilePrArgs.body`), which is
 * what carries the `-no-color` plan through. Note that the pull-request mode
 * of `reconcilePr` regenerates chant TypeScript via `chant import`; a
 * terraform-native regeneration of HCL from live state is #2089, so until
 * then `findingMode: "issue"` is the mode with an end-to-end answer and
 * `"pull-request"` opens a PR whose body is the plan.
 *
 * ## The schedule
 *
 * A cron makes this a `{ op, schedule }` pair, the shape
 * `lexicons/temporal/src/composites/workflow-audit-op.ts` and
 * `reconcile-op.ts` return. The schedule resource is `Temporal::Schedule`,
 * built here through core's own `createResource` rather than imported from
 * `@intentius/chant-lexicon-temporal`: no lexicon in this repo imports
 * another lexicon's package at runtime, and a static import would mean a
 * project that installs terraform and runs `chant run` on the local executor
 * could not load `@intentius/chant-lexicon-terraform` at all without also
 * installing temporal. The declarable is the same one temporal's
 * `TemporalSchedule` produces (`createResource("Temporal::Schedule",
 * "temporal", {})`, `lexicons/temporal/src/resources.ts`), so temporal's
 * serializer renders it unchanged when a project has both.
 *
 * A project with no Temporal at all runs the same Op on a CI cron instead:
 * `generateOpsPipeline` against the github lexicon turns the Op plus its cron
 * into a workflow. `examples/scheduled-watch/` is that recipe.
 *
 * @example
 * ```typescript
 * import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";
 *
 * // one-shot, local executor: chant run app-watch
 * export const { op } = TerraformWatchOp({ name: "app-watch", root: "app" });
 *
 * // nightly, opening an issue when the plan is non-empty
 * export const { op, schedule } = TerraformWatchOp({
 *   name: "app-watch",
 *   root: "app",
 *   schedule: "0 6 * * *",
 *   findingMode: "issue",
 * });
 * ```
 */

import { Op, phase, OpResource, type ActivityStep } from "@intentius/chant/op";
import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import { DEFAULT_PLAN_FILE } from "../op/activities/terraform";
import { terraformInit as initStep, terraformPlan as planStep } from "../op/builders";

/**
 * What to do with a non-empty plan. A subset of core's `OpFindingMode`
 * (`packages/core/src/lexicon.ts`): `merge-request` is GitLab's spelling of
 * `pull-request` and is produced by the CI generator, not chosen here.
 */
export type TerraformFindingMode = "report" | "issue" | "pull-request";

/**
 * `Temporal::Schedule`, built without importing the temporal lexicon. See the
 * module doc for why. Identical to `TemporalSchedule` in
 * `lexicons/temporal/src/resources.ts`.
 */
const ScheduleResource = createResource("Temporal::Schedule", "temporal", {});

/** `app-watch` becomes `appWatchWorkflow`, matching the temporal serializer's naming. */
function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface TerraformWatchOpConfig {
  /** Op name (kebab-case). Also the default task queue and schedule id base. */
  name: string;
  /** Key into the project's `terraform.roots`. The root carries dir, workspace, var files and backend config. */
  root: string;
  /**
   * Cron expression. When set, a `Temporal::Schedule` is returned alongside
   * the Op; omit for one-shot `chant run` on the local executor, or for a CI
   * cron built by `generateOpsPipeline`.
   */
  schedule?: string;
  /**
   * What to do when the plan proposes changes. Default: `"report"`, which
   * opens nothing. The `Drift` search attribute and the run's own log are
   * the report.
   */
  findingMode?: TerraformFindingMode;
  /** Plan file the Plan step writes, relative to the root dir. Default: `chant.tfplan`. */
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
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface TerraformWatchOpResources {
  /** Op resource. Generates the Init/Plan/[Report] workflow. */
  op: InstanceType<typeof OpResource>;
  /** `Temporal::Schedule`, present only when `schedule` was given. */
  schedule?: Declarable;
}

export function TerraformWatchOp(config: TerraformWatchOpConfig): TerraformWatchOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const planFile = config.planFile ?? DEFAULT_PLAN_FILE;
  const findingMode: TerraformFindingMode = config.findingMode ?? "report";
  const where = config.cwd ? { cwd: config.cwd } : {};

  // `id` is what makes `plan.out` legal, and `plan.out.text` is the only
  // channel by which any part of the plan leaves this Op.
  const plan = planStep(config.root, { planFile, ...where, id: "plan" });
  plan.outcomeAttribute = { name: "Drift", from: "changed" };

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
        body: plan.out.text,
        ...(config.branch ? { branch: config.branch } : {}),
      },
      outcomeAttribute:
        findingMode === "pull-request" ? { name: "PR", from: "prUrl" } : { name: "Issue", from: "issueUrl" },
    };
    phases.push(phase("Report", [report]));
  }

  const op = Op({
    name: config.name,
    overview: `Plan the "${config.root}" terraform root and report drift`,
    taskQueue,
    searchAttributes: {
      Watch: "true",
      TerraformRoot: config.root,
    },
    phases,
  });

  if (!config.schedule) return { op };

  const schedule = new ScheduleResource({
    scheduleId: `${config.name}-schedule`,
    spec: { cronExpressions: [config.schedule] },
    action: {
      workflowType: kebabToCamel(config.name) + "Workflow",
      taskQueue,
    },
  });

  return { op, schedule };
}
