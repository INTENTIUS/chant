/**
 * Pulumi and plunge exit statuses mapped onto chant's exit-code table
 * (#4553, `CHANT_EXIT` in `@intentius/chant/exit-codes`).
 *
 * Pulumi's own codes (`pkg/cmd/pulumi/cmd/exit_codes.go` upstream) overlap
 * chant's numbers with other meanings: Pulumi's 3 is an authentication
 * failure, chant's 3 a run waiting on a person. So nothing passes a raw
 * Pulumi code through; every code the lexicon reads goes through
 * {@link pulumiExitOf}. A Pulumi older than its exit-code taxonomy exits 1 for
 * everything, which maps to `failed`, still right.
 *
 * The pulumi apply capability (#4541) wires this into its step: a plan that
 * moved throws an error with `planMoved: true`, and core exits
 * `CHANT_EXIT.moved`.
 */
import { CHANT_EXIT, type ChantExitCode } from "@intentius/chant/exit-codes";

/** Pulumi's exit statuses. */
export const PULUMI_EXIT = {
  success: 0,
  error: 1,
  configuration: 2,
  authentication: 3,
  resource: 4,
  policyViolation: 5,
  stackNotFound: 6,
  /** `--expect-no-changes` found changes. */
  noChanges: 7,
  cancelled: 8,
  timeout: 9,
  await: 10,
  internal: 255,
} as const;

/** plunge's exit status for a saved plan that moved, or one with no stamp (`pkg/backend/plunge/planstamp.go`, `ExitPlanMoved`). */
export const PLUNGE_PLAN_MOVED_EXIT = 40;

/**
 * The table's code for a `pulumi` or `plunge` exit status.
 *
 * | Pulumi or plunge | Table |
 * |---|---|
 * | 0 | `done` |
 * | 5 policy violation (a mandatory CrossGuard pack) | `denied` |
 * | 7 changes under `--expect-no-changes` (a drift job's refresh) | `drift` |
 * | plunge 40, a moved or unstamped plan | `moved` |
 * | 1, 2 configuration, 3 authentication, 4 resource, 6 stack not found, 8 cancelled, 9 timeout, 10 await, 255, anything else | `failed` |
 *
 * A configuration error is `failed`: the table has no usage code of its own.
 * Stock Pulumi's moved preview shape (`PlanShapeMovedError`) is core's moved
 * mark already and never reaches here as a code.
 */
export function pulumiExitOf(code: number | null | undefined): ChantExitCode {
  switch (code) {
    case PULUMI_EXIT.success:
      return CHANT_EXIT.done;
    case PULUMI_EXIT.policyViolation:
      return CHANT_EXIT.denied;
    case PULUMI_EXIT.noChanges:
      return CHANT_EXIT.drift;
    case PLUNGE_PLAN_MOVED_EXIT:
      return CHANT_EXIT.moved;
    default:
      return CHANT_EXIT.failed;
  }
}

/** Whether a `pulumi` or `plunge` exit status is a plan that moved since its approval. */
export function pulumiPlanMoved(code: number | null | undefined): boolean {
  return pulumiExitOf(code) === CHANT_EXIT.moved;
}
