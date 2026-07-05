/**
 * Ownership marker contract.
 *
 * chant stamps managed resources with a provider-native marker at synthesis
 * time. This is what later lets `delete` be precise without an authoritative
 * state file — the ownership record lives on the cloud resource, not in a file
 * chant has to host or lock. The marker is standard tags/labels, so walk-away
 * cost stays zero: nothing proprietary lands in the output.
 *
 * The marker carries stack identity, not just `managed=true`, so one stack
 * never mistakes another stack's resources for its own. Ownership means
 * "carries chant's marker", not "carries only chant's marker" — co-stamping
 * with other tools is fine.
 */

/** The value of the managed-by marker for every channel. */
export const OWNERSHIP_MANAGED_BY_VALUE = "chant";

/**
 * Stack (and optional environment) identity stamped onto a resource. Computed
 * from project config and threaded into each serializer.
 */
export interface OwnershipMarker {
  /** Distinguishes one chant stack's resources from another's. */
  stack: string;
  /** Optional environment identity. */
  env?: string;
}

/**
 * The marker key names a target stamps into — the managed-by/stack/env tag or
 * label keys. Tag-key syntax differs per provider (Kubernetes/GCP labels allow
 * a `prefix/name` form; AWS tag keys allow `:`; Azure tag keys forbid `/`), so
 * each cloud lexicon provides its own `ChannelKeys` and passes it to these
 * helpers. Core owns the generic stamp/detect logic and the shared label
 * convention (`LABEL_OWNERSHIP_KEYS`), not a per-provider key registry.
 */
export interface ChannelKeys {
  readonly managedBy: string;
  readonly stack: string;
  readonly env: string;
}

/**
 * The label-based ownership convention (`app.kubernetes.io/managed-by` +
 * `chant.intentius.io/{stack,env}`) — the default, shared by every label-based
 * lexicon (k8s, gcp, helm, and the Temporal apply activity's `kubectl --prune`
 * selector). AWS and Azure tag keys are defined in their own lexicons.
 */
export const LABEL_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "app.kubernetes.io/managed-by",
  stack: "chant.intentius.io/stack",
  env: "chant.intentius.io/env",
};

/**
 * The key/value entries to stamp: the managed-by marker, the stack identity,
 * and the env identity when present.
 */
export function ownershipEntries(
  keys: ChannelKeys,
  marker: OwnershipMarker,
): Record<string, string> {
  const entries: Record<string, string> = {
    [keys.managedBy]: OWNERSHIP_MANAGED_BY_VALUE,
    [keys.stack]: marker.stack,
  };
  if (marker.env) entries[keys.env] = marker.env;
  return entries;
}

/**
 * Ownership test: does this resource carry chant's managed-by marker? Other
 * tools may co-stamp; only the managed-by marker is required to count as owned.
 */
export function hasOwnershipMarker(
  tagsOrLabels: Record<string, unknown> | undefined,
  keys: ChannelKeys,
): boolean {
  if (!tagsOrLabels) return false;
  return tagsOrLabels[keys.managedBy] === OWNERSHIP_MANAGED_BY_VALUE;
}

/**
 * The two live-side ownership verdicts a marker query can produce.
 *
 * - `owned` — carries chant's marker; an undeclared owned resource is a safe
 *   delete candidate.
 * - `foreign` — no marker; can be adopted but never auto-deleted.
 *
 * The third verdict, `unknown`, is reserved for when no marker channel was
 * queried at all (see the `Ownership` type in the change set).
 */
export function classifyOwnership(
  tagsOrLabels: Record<string, unknown> | undefined,
  keys: ChannelKeys,
): "owned" | "foreign" {
  return hasOwnershipMarker(tagsOrLabels, keys) ? "owned" : "foreign";
}

/**
 * Convert a tag array of `{Key, Value}` (AWS/CloudFormation form) into the
 * key→value map the ownership helpers expect.
 */
export function tagArrayToMap(
  tags: ReadonlyArray<{ Key?: string; Value?: unknown }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of tags ?? []) {
    if (typeof t.Key === "string") out[t.Key] = t.Value;
  }
  return out;
}

/**
 * Read the stack/env identity from a marked resource's tags/labels. Returns
 * undefined when the managed-by marker is absent.
 */
export function readOwnership(
  tagsOrLabels: Record<string, unknown> | undefined,
  keys: ChannelKeys,
): OwnershipMarker | undefined {
  if (!hasOwnershipMarker(tagsOrLabels, keys)) return undefined;
  const stack = tagsOrLabels![keys.stack];
  const env = tagsOrLabels![keys.env];
  return {
    stack: typeof stack === "string" ? stack : "",
    env: typeof env === "string" ? env : undefined,
  };
}
