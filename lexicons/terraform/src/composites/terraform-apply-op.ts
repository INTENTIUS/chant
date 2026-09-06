/**
 * TerraformApplyOp composite (#2086), init, plan, approve, apply for one root
 * module named in `terraform.roots`.
 *
 * Authority stays with terraform: chant runs the binary, reads its plan, and
 * hands the same saved plan to apply. The Apply step never applies something
 * no gate saw, because it takes the Plan step's own `planFile` as a
 * `StepOutputRef`.
 *
 * Phases: Init, Plan, Gate, Apply. One shape, both kinds of root. A live root
 * (#2103, `terraform.binary: "choudoufu"` plus a declared estate) ran a
 * different shape for one release, because choudoufu refused `-out` and
 * `apply <planfile>`; choudoufu v0.13.0 admits both under a `live` block
 * ([choudoufu #878](https://github.com/INTENTIUS/choudoufu/issues/878),
 * PR 889), so the plan-file discipline is back and the two shapes are one
 * again.
 *
 * **What the approval covers on a live root.** `plan -out=<planFile>` writes
 * stock's own plan file, and that file is what the approver reads and what
 * the Apply step names. `apply <planFile>` does not replay it: prior state on
 * a live root is a projection rebuilt from the live system every run, so the
 * apply re-plans against the live system the way every live-markers run does,
 * then compares its fresh plan with the file's. Same addresses, same actions,
 * same live objects, and the same planned values, or it refuses before
 * anything changes:
 *
 *   - `The approved plan no longer matches the live system`, and
 *   - `The approved plan belongs to a different estate`,
 *
 * both with exit status **3**, which is neither 1 (any ordinary failure) nor
 * `-detailed-exitcode`'s 2. `terraformApply` maps that status to a named
 * result rather than a thrown error (`refused: "approval-mismatch" |
 * "wrong-estate"`, with choudoufu's message in `refusal`), so a workflow
 * reading the Apply step's output can route the run back to review instead of
 * treating it as a broken step. The seam #2106 left named and unused on the
 * apply args is now the plan file itself.
 *
 * TF101 therefore fires on a live root's `terraformApply` call again: there
 * is a plan file to pair once more, and pairing it is what the refusal above
 * has to compare against.
 *
 * **Delete modes.** chant's `delete: "never" | "owned-only" | "gated"`
 * (`terraform.roots.<name>.delete`, `../config.ts`) maps onto choudoufu's
 * `policy` block. `"owned-only"` is choudoufu's own default verb for the
 * `undeclared_tagged` quadrant (an orphaned marked resource) and needs
 * nothing; `"gated"` needs nothing beyond this composite's own approval gate;
 * `"never"` requires the root's `policy` block to set `undeclared_tagged` to
 * `"keep"`, `"untag"` or `"report"`, and TF026 (`../lint/post-synth/tf026.ts`)
 * enforces that at build time, naming the setting to add. Separately, and
 * regardless of `delete`, this composite refuses outright to build against a
 * root whose `policy` sets `undeclared_untagged = "delete"` (account-scoped
 * reconciliation, which needs a `scope` block): that quadrant deletes
 * resources the estate never claimed, anywhere the scope reaches, and chant
 * never proposes deleting a resource it does not own, not for a root, and not
 * for an Op it generated.
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
import { detectLivePolicyVerbs } from "../op/activities/live-detect";
import { resolveRootModeSync } from "../op/resolve-root-mode";
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
   * total or refused, the same stance `ApplyOp` takes (`packages/core/src/op/
   * composites/apply-op.ts`) — `true`, or an object with no `command`, throws
   * when the Op is built, naming the Op, rather than warning at the moment a
   * rollback is already needed. Supply `compensate: { command: "..." }` with a
   * rollback of your own, or leave it unset.
   */
  compensate?: boolean | { command?: string };
}

export interface TerraformApplyOpResources {
  /** Op resource — generates the Init/Plan/[Gate]/Apply workflow. */
  op: InstanceType<typeof OpResource>;
}

export function TerraformApplyOp(config: TerraformApplyOpConfig): TerraformApplyOpResources {
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

  // Best-effort, synchronous (chant.config.json only — see
  // resolveRootModeSync's own doc comment): "unknown" reads as stock, the
  // conservative direction. The mode no longer changes which steps are
  // emitted; it decides the policy refusal below and the wording of the gate.
  const resolved = resolveRootModeSync(config.root, config.cwd);
  const live = resolved?.mode === "live";

  if (live) {
    // Regardless of `delete`: an account-scoped purge is never something
    // chant proposes on an Op's own initiative. TF026 handles the narrower,
    // config-driven `delete: "never"` requirement; this is unconditional.
    const verbs = detectLivePolicyVerbs(resolved!.dir);
    if (verbs?.undeclaredUntagged === "delete") {
      throw new Error(
        `TerraformApplyOp "${config.name}": root "${config.root}"'s policy block sets ` +
          `undeclared_untagged = "delete" (account-scoped reconciliation, scoped by a \`scope\` block). ` +
          "chant never proposes deleting a resource it does not own, and neither does an Op it " +
          "generates. Remove that setting from the policy block, or narrow the estate's ownership " +
          "answer instead of the account's.",
      );
    }
  }

  const phases = [
    phase("Init", [initStep(config.root, { ...where, ...(config.upgrade ? { upgrade: true } : {}) })]),
  ];

  // `id` is what makes `plan.out` legal, and `plan.out.planFile` is how the
  // Apply step below names this step's saved plan. On a live root that file
  // is also the approval artifact the apply re-plans against, so the same
  // reference carries the approval as well as the path.
  const plan = planStep(config.root, { planFile, ...where, id: "plan" });
  plan.outcomeAttribute = { name: "Changed", from: "changed" };
  phases.push(phase("Plan", [plan]));

  if (gateMode !== "never") {
    // Re-render the saved plan just before the wait, so the approver's
    // `Destroys` attribute comes off the plan that will actually apply.
    // `show` against a plan file calls no provider, on either kind of root.
    const show = showStep(config.root, { ...where, planFile: plan.out.planFile });
    show.outcomeAttribute = { name: "Destroys", from: "destroys" };
    phases.push(
      phase("Gate", [
        show,
        gate(config.signalName ?? `approve-${config.name}`, {
          ...(config.gateTimeout ? { timeout: config.gateTimeout } : {}),
          description:
            config.gateDescription ??
            `Approve terraform apply of ${live ? "live " : ""}root "${config.root}" (gate: ${gateMode}). ` +
              `The Destroys search attribute on this phase is the plan's destroy count.` +
              (live
                ? " The apply that follows re-plans against the live system and applies this plan file only" +
                  " if its own fresh plan agrees; otherwise it refuses with exit status 3 and the Apply" +
                  " step reports a named refusal for review (choudoufu #878)."
                : ""),
        }),
      ]),
    );
  }

  phases.push(phase("Apply", [applyStep(config.root, { ...where, planFile: plan.out.planFile })]));

  const op = Op({
    name: config.name,
    overview: `Init, plan and apply the "${config.root}" terraform root`,
    labels: {
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
