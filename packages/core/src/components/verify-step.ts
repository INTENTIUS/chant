/**
 * What chant counts as a failed verify (#5339, #5328): one definition, which
 * the verify-failed agent trigger (`../ci-agent-verify-failed.ts`) and a
 * stage's requested rollback (`../pipeline/verify-rollback.ts`) both read, so
 * the two agree on the same failure.
 *
 * A verify step is a step in a phase named `Verify`, or a step of a
 * wait-and-verify kind ({@link VERIFY_STEP_KINDS}) wherever its phase is. A
 * run that failed at any other step, such as an apply, failed but did not
 * fail its verify.
 *
 * Bundle-safe: this module imports nothing.
 */

/**
 * The step kinds a failed promote counts as a failed verify wherever their
 * phase is: core's wait-and-verify verbs (`STARTER_VERB_FAMILIES.waitVerify`
 * in `./starter-plugin.ts`) and the HTTP check.
 */
export const VERIFY_STEP_KINDS: readonly string[] = ["wait-cluster-healthy", "wait-endpoint", "health-gate", "http-check"];

/** Whether a step is a verify step: in a phase named `Verify`, or of a kind in {@link VERIFY_STEP_KINDS}. */
export function isVerifyStep(step: { phase: string; kind: string }): boolean {
  return /^verify$/i.test(step.phase.trim()) || VERIFY_STEP_KINDS.includes(step.kind);
}

/** Whether a run's step records hold a failed verify step: a record with status `fail` that {@link isVerifyStep} names. */
export function failedVerify(records: readonly { phase: string; kind: string; status: string }[]): boolean {
  return records.some((r) => r.status === "fail" && isVerifyStep(r));
}
