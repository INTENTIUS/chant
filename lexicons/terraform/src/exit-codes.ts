/**
 * OpenTofu, Terraform and choudoufu outcomes mapped onto chant's exit-code
 * table (#4553, `CHANT_EXIT` in `@intentius/chant/exit-codes`).
 *
 * The lexicon never picks the process's exit code itself: for a moved plan it
 * throws an error core marks as moved (`planMoved: true`, read by
 * `isPlanMovedError`), and core exits `CHANT_EXIT.moved`. This mapping says
 * which engine outcome is which row of the table, so the throw sites and the
 * reference page agree.
 *
 * | Engine outcome | Table |
 * |---|---|
 * | `plan -detailed-exitcode` 0 or 2 | not an exit: the plan's answer. 2 under a drift check is `drift` |
 * | any 1 | `failed` |
 * | choudoufu `apply <planfile>` 3, approval mismatch | `moved` |
 * | choudoufu `apply <planfile>` 3, plan made against another estate | `failed`: the pipeline handed the wrong file, and no approval fixes that |
 * | choudoufu `live-wave-apply` 3, set moved | `moved` |
 * | choudoufu `live-wave-apply` 4 or `live-plan-set` 4, a root failed | `failed` |
 * | a composed plan that moved | `moved` |
 * | `live-affected` 2, `live-cone` 2 | planner answers, never a job's exit |
 */
import { CHANT_EXIT, type ChantExitCode } from "@intentius/chant/exit-codes";
import { CHOUDOUFU_APPROVAL_EXIT_CODE, CHOUDOUFU_WAVE_EXIT, type TerraformApprovalRefusal } from "./op/activities/terraform";

/** The command whose exit status is mapped. */
export type TerraformExitSource =
  /** `terraform|tofu|choudoufu plan -detailed-exitcode`; `drift` says a drift check asked for it. */
  | { command: "plan"; code: number; drift?: boolean }
  /** `choudoufu apply <planfile>` on a live root; `refusal` is `classifyApprovalRefusal`'s answer for its output. */
  | { command: "apply"; code: number; refusal?: TerraformApprovalRefusal }
  /** `choudoufu live-wave-apply`. */
  | { command: "live-wave-apply"; code: number }
  /** `choudoufu live-plan-set`. */
  | { command: "live-plan-set"; code: number };

/**
 * The table's code for a terraform, tofu or choudoufu exit status. A plan's
 * 0 and 2 are both `done` unless a drift check asked, when 2 is `drift`.
 */
export function terraformExitOf(source: TerraformExitSource): ChantExitCode {
  const { code } = source;
  if (code === 0) return CHANT_EXIT.done;
  switch (source.command) {
    case "plan":
      if (code === 2) return source.drift ? CHANT_EXIT.drift : CHANT_EXIT.done;
      return CHANT_EXIT.failed;
    case "apply":
      return code === CHOUDOUFU_APPROVAL_EXIT_CODE && source.refusal === "approval-mismatch" ? CHANT_EXIT.moved : CHANT_EXIT.failed;
    case "live-wave-apply":
      return code === CHOUDOUFU_WAVE_EXIT.setMoved ? CHANT_EXIT.moved : CHANT_EXIT.failed;
    case "live-plan-set":
      return code === 2 ? CHANT_EXIT.done : CHANT_EXIT.failed;
  }
}

/** Whether `source` is a plan that moved since its approval: the outcomes the lexicon throws a `planMoved` error for. */
export function terraformPlanMoved(source: TerraformExitSource): boolean {
  return terraformExitOf(source) === CHANT_EXIT.moved;
}
