/**
 * A terminal activity failure.
 *
 * Some activities fail deterministically: an organizational policy violation
 * (`policyGate`) or a cfn-guard finding (`guardValidate`) reads the same on the
 * second attempt as on the first, so a retry only delays the report. Those
 * activities used to raise an orchestrator SDK's non-retryable failure type,
 * which put that SDK on the import path of every base activity. Core owns the
 * base activities now (chant #2114), and depends on no runtime SDK — this is
 * the same signal in a plain `Error`.
 *
 * `name` is the failure type, not the class name, so the local executor's
 * `retry.nonRetryableErrorTypes` (which matches on `Error.name`) can name it in
 * a profile. `type` and `nonRetryable` are kept alongside it because that is
 * the shape callers and tests already read.
 */
export class NonRetryableActivityError extends Error {
  /** Always true — present so a caller can branch without an `instanceof`. */
  readonly nonRetryable = true;

  constructor(
    message: string,
    /** Failure type, e.g. `"PolicyViolation"`. Also this error's `name`. */
    readonly type: string,
  ) {
    super(message);
    this.name = type;
  }
}

/** Build a {@link NonRetryableActivityError} — a non-retryable failure with no SDK behind it. */
export function nonRetryableFailure(message: string, type: string): NonRetryableActivityError {
  return new NonRetryableActivityError(message, type);
}
