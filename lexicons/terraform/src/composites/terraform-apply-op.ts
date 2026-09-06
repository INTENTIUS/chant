/**
 * TerraformApplyOp composite (#2086) — init, plan, approve, apply for one root
 * module named in `terraform.roots`.
 *
 * Authority stays with terraform: chant runs the binary, reads its plan, and
 * hands the same saved plan to apply. The Apply step never re-plans, because
 * it takes the Plan step's own `planFile` as a `StepOutputRef` — whatever was
 * approved is what runs.
 *
 * Phases: Init, Plan, Gate, Apply.
 *
 * The gate is durable-runtime work, so an Op that emits one needs Temporal;
 * `packages/core/src/op/local-executor.ts` refuses any Op containing a gate.
 * `gate: "never"` is what makes the Op runnable with `chant run` locally.
 *
 * @example
 * ```typescript
 * import { TerraformApplyOp } from "@intentius/chant-lexicon-terraform";
 *
 * export const { op } = TerraformApplyOp({ name: "app-apply", root: "app" });
 * ```
 */

import { Op, phase, gate, activity, OpResource } from "@intentius/chant/op";
import { DEFAULT_PLAN_FILE } from "../op/activities/terraform";
import {
  terraformInit as initStep,
  terraformPlan as planStep,
  terraformApply as applyStep,
  terraformShow as showStep,
} from "../op/builders";

/**
 * When to pause for a human before applying.
 *
 * `GateStep` (`packages/core/src/op/types.ts`) carries a signal name, a
 * timeout and a description, and nothing conditional — so `"on-destroy"`
 * cannot branch at build time on a count the plan only produces at run time.
 * The workable v1 is that `"on-destroy"` and `"always"` emit the same Gate
 * phase, and the approver is told what is at stake instead: the phase reports
 * the plan's `destroys` count as the `Destroys` search attribute before it
 * waits, and the gate description says so. A gate that skips itself when the
 * plan turns out additive is a new step kind, out of scope here.
 */
export type TerraformGateMode = "on-destroy" | "always" | "never";

export interface TerraformApplyOpConfig {
  /** Op name (kebab-case). Also the default task queue and gate signal suffix. */
  name: string;
  /** Key into the project's `terraform.roots`. The root carries dir, workspace, var files and backend config. */
  root: string;
  /** Plan file written by Plan and consumed by Apply, relative to the root dir. Default: `chant.tfplan`. */
  planFile?: string;
  /**
   * When to emit the approval gate. Default: `"on-destroy"`. See
   * {@link TerraformGateMode} for why `"on-destroy"` and `"always"` build the
   * same phase.
   */
  gate?: TerraformGateMode;
  /** Gate signal name. Default: `approve-<name>`, as `ApplyOp` does. */
  signalName?: string;
  /** Temporal duration the gate waits before timing out. Default: core's own (48h). */
  gateTimeout?: string;
  /** Override the gate description shown to the approver. */
  gateDescription?: string;
  /** `-upgrade` on the Init step: re-resolve provider and module versions. */
  upgrade?: boolean;
  /**
   * Directory each step starts the `chant.config.*` search from, which is
   * what `terraform.roots` and the root's relative `dir` resolve against.
   * Default: the running process's cwd, which is the project root under
   * `chant run`.
   */
  cwd?: string;
  /**
   * Saga-style rollback on a failed apply, run as an `onFailure` phase.
   *
   * Terraform has no automatic rollback: a half-applied plan is undone by
   * planning and applying the inverse, which is a decision about the estate
   * rather than something chant can synthesize. So compensation here is
   * total or refused, the same stance `ApplyOp` takes (`lexicons/temporal/src/
   * composites/apply-op.ts`) — `true`, or an object with no `command`, throws
   * when the Op is built, naming the Op, rather than warning at the moment a
   * rollback is already needed. Supply `compensate: { command: "..." }` with a
   * rollback of your own, or leave it unset.
   */
  compensate?: boolean | { command?: string };
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface TerraformApplyOpResources {
  /** Op resource — generates the Init/Plan/[Gate]/Apply workflow. */
  op: InstanceType<typeof OpResource>;
}

export function TerraformApplyOp(config: TerraformApplyOpConfig): TerraformApplyOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const planFile = config.planFile ?? DEFAULT_PLAN_FILE;
  const gateMode: TerraformGateMode = config.gate ?? "on-destroy";

  // Terraform has no rollback to run, so asking for one without supplying it
  // fails here, at build time, with the Op named — not as a warning when the
  // apply has already half-run. Same shape as ApplyOp's refusal (#1449).
  const compensateCommand = typeof config.compensate === "object" ? config.compensate.command : undefined;
  if (config.compensate !== undefined && config.compensate !== false && compensateCommand === undefined) {
    throw new Error(
      `TerraformApplyOp "${config.name}": compensate is enabled, but terraform has no automatic ` +
        `rollback — undoing a partial apply means planning and applying the inverse, which is a ` +
        `decision about the estate rather than something chant can synthesize. Either supply ` +
        `compensate: { command: "..." } with a rollback of your own, or set compensate: false.`,
    );
  }

  // Every step resolves the root through the same project config, so the cwd
  // travels with each of them rather than being read off the process once.
  const where = config.cwd ? { cwd: config.cwd } : {};

  // `id` is what makes `plan.out` legal, and `plan.out.planFile` is how the
  // Apply step below names this step's saved plan.
  const plan = planStep(config.root, { planFile, ...where, id: "plan" });
  plan.outcomeAttribute = { name: "Changed", from: "changed" };

  const phases = [
    phase("Init", [initStep(config.root, { ...where, ...(config.upgrade ? { upgrade: true } : {}) })]),
    phase("Plan", [plan]),
  ];

  if (gateMode !== "never") {
    // Re-render the saved plan just before the wait, so the approver's
    // `Destroys` attribute comes off the plan that will actually apply.
    // `show` against a plan file calls no provider.
    const show = showStep(config.root, { ...where, planFile: plan.out.planFile });
    show.outcomeAttribute = { name: "Destroys", from: "destroys" };
    phases.push(
      phase("Gate", [
        show,
        gate(config.signalName ?? `approve-${config.name}`, {
          ...(config.gateTimeout ? { timeout: config.gateTimeout } : {}),
          description:
            config.gateDescription ??
            `Approve terraform apply of root "${config.root}" (gate: ${gateMode}). ` +
              `The Destroys search attribute on this phase is the plan's destroy count.`,
        }),
      ]),
    );
  }

  phases.push(phase("Apply", [applyStep(config.root, { ...where, planFile: plan.out.planFile })]));

  const op = Op({
    name: config.name,
    overview: `Init, plan and apply the "${config.root}" terraform root`,
    taskQueue,
    searchAttributes: {
      Apply: "true",
      TerraformRoot: config.root,
    },
    phases,
    ...(compensateCommand
      ? { onFailure: [phase("Rollback", [activity("shellCmd", { cmd: compensateCommand })])] }
      : {}),
  });

  return { op };
}
