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

/**
 * The property a failing activity sets on the error it throws to publish
 * outputs it already knew when it failed (chant#4512). terraformInit knows its
 * root's directory once the root resolves and before `terraform init` runs, so
 * a failed init still names the root it was for.
 *
 * It is a plain property, not a class, so a lexicon can set it without
 * importing anything newer from core: an executor that predates it reads the
 * error as any other failure.
 */
export const KNOWN_OUTPUTS_KEY = "knownOutputs";

/** An activity error carrying the outputs it knew before it failed (chant#4512). */
export type ErrorWithKnownOutputs = Error & { [KNOWN_OUTPUTS_KEY]: Record<string, unknown> };

/**
 * Attach `outputs` to `err` as the outputs the activity knew when it failed,
 * and hand the error back for the activity to rethrow. A thrown non-Error is
 * wrapped in one, so its message survives.
 */
export function withKnownOutputs(err: unknown, outputs: Record<string, unknown>): ErrorWithKnownOutputs {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { [KNOWN_OUTPUTS_KEY]: outputs });
}

/**
 * The outputs a failed activity published on its error (chant#4512), or
 * undefined when it published none. An executor resolves a failed step's
 * `outcomeAttribute` paths against these, as it does against a result.
 */
export function knownOutputsOf(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const known = (err as Record<string, unknown>)[KNOWN_OUTPUTS_KEY];
  return typeof known === "object" && known !== null && !Array.isArray(known) ? (known as Record<string, unknown>) : undefined;
}
