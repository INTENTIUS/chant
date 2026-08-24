/**
 * The `generated-once` marker label (chant #1830, epic #1365 decision 5).
 *
 * `k8sSecretStore` (./secret-store.ts) stamps this label onto every Secret it
 * mints, next to the ownership marker. Both k8s prune paths key on it:
 *
 * - the apply-path prune (`applyManifest`'s owned-only sweep,
 *   op/activities/kubectl.ts) excludes a labeled Secret from the prunable set
 *   and reports it `retained` instead of deleting it;
 * - env teardown (./teardown.ts `executeTeardown`) reports the same `retained`
 *   outcome for it, loudly, and never deletes it.
 *
 * The rationale is the materialization contract: the stored bytes are the ONLY
 * copy of material chant never held, so no sweep may destroy them. Deletion is
 * an explicit human act — `kubectl delete secret <name>`, or a future gated
 * op — never a side effect of "no longer declared".
 *
 * Dependency-light on purpose: no client import, so the constants are usable
 * from the build path, the prune paths, and the docs/tests alike.
 */

/** The label key a generated-once Secret carries. */
export const GENERATED_ONCE_LABEL_KEY = "chant.intentius.io/generated-once";

/** The label value `k8sSecretStore` stamps. */
export const GENERATED_ONCE_LABEL_VALUE = "true";

/**
 * True when a live object's labels mark it generated-once. Any non-empty
 * value counts: the label's presence is the claim, and a sweep must err on
 * the side of keeping.
 */
export function isGeneratedOnce(labels: Record<string, unknown> | undefined): boolean {
  const value = labels?.[GENERATED_ONCE_LABEL_KEY];
  return typeof value === "string" && value.length > 0;
}
