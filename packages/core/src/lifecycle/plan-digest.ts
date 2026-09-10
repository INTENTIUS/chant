/**
 * Plan identity for a gate (#2300, measured on INTENTIUS/choudoufu#1026).
 *
 * A gate resolution used to carry the op, the gate, the approver and a
 * timestamp, and nothing about what was approved. Approve, edit the root,
 * re-run, and the second run re-planned and applied: the resolution had
 * authorised the *next run* of that op rather than the plan the approver
 * read. This module is the missing half — one string that identifies a plan,
 * written onto the pending fact the run records, onto the resolution `chant
 * approve` appends, and compared by {@link latestResolutionForPlan} when a
 * later run decides the gate.
 *
 * ## What a digest covers
 *
 * The change set, and only the change set: what a run proposes to create,
 * update, replace or destroy, at which addresses, with which values. Two
 * plans share a digest exactly when applying either one would do the same
 * thing to the estate.
 *
 * ## What it deliberately does not cover
 *
 * - **When the plan was taken.** A plan file's own `timestamp`, and the
 *   resolution's. Re-planning an unchanged root a minute later must produce
 *   the same digest, or every approval would expire on the clock rather than
 *   on the content.
 * - **Which run took it.** `runId`, the CI job number, the workflow attempt.
 *   Approving a plan and re-running the workflow is the whole loop; binding
 *   the run id would make the approval unusable by the run that consumes it.
 * - **The tool that produced it.** The terraform/choudoufu version, the plan
 *   file's binary bytes and its path on disk. The digest is taken over the
 *   `show -json` rendering rather than the file, so a plan-format bump does
 *   not read as a changed plan.
 * - **Who approved it, or where.** `resolvedBy`, `note`, `url` — those
 *   describe the approval, not the plan.
 *
 * The identity is therefore a claim about consequence, not about provenance.
 * That is the claim an approver is actually making.
 */
import { sortedJsonReplacer } from "../utils";
import { getRuntime } from "../runtime-adapter";

/** The hash a plan digest is taken with, and the prefix every digest carries. */
export const PLAN_DIGEST_ALGORITHM = "sha256";

/** Shape of a well-formed digest: `sha256:` and 64 lowercase hex characters. */
const PLAN_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Hash a plan's change set into a stable identity.
 *
 * `kind` names the shape `subject` is in (`"terraform-plan"`,
 * `"lifecycle-diff"`), and is hashed alongside it so two different kinds of
 * plan can never collide into the same digest by coincidence — a gate bound
 * to a terraform plan must not be satisfiable by a lifecycle diff that
 * happened to serialize identically.
 *
 * `subject` is canonicalised by {@link sortedJsonReplacer}, so object key
 * order — which neither terraform's JSON writer nor `JSON.parse` guarantees
 * across versions — does not change the answer. It is the caller's job to
 * hand in a projection that already excludes the volatile fields this
 * module's doc comment lists.
 */
export function computePlanDigest(kind: string, subject: unknown): string {
  const canonical = JSON.stringify({ kind, subject }, sortedJsonReplacer);
  return `${PLAN_DIGEST_ALGORITHM}:${getRuntime().hash(canonical)}`;
}

/**
 * Whether `raw` is a digest this code produced. Used at the `chant approve
 * --plan` boundary, so a typo, a truncated copy-paste or a plan *file* path
 * is refused before it is written into an immutable resolution that would
 * then never match anything.
 */
export function isPlanDigest(raw: unknown): raw is string {
  return typeof raw === "string" && PLAN_DIGEST_PATTERN.test(raw);
}

/**
 * A digest as it reads in a message, and the one place that decides how an
 * absent one reads. Records written before #2300 carry no digest at all, and
 * "(none — recorded before plan-bound gates)" is what a refusal has to say
 * about them instead of printing `undefined`.
 */
export function describePlanDigest(digest: string | undefined): string {
  return digest ?? "(none — recorded before plan-bound gates)";
}
