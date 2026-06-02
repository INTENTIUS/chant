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
 * The native metadata channel a target stamps into. Tag-key syntax differs:
 * Kubernetes/GCP labels allow a `prefix/name` form; AWS tag keys allow `:`;
 * Azure tag keys forbid `/`, so they use a hyphenated form.
 */
export type OwnershipChannel = "label" | "aws-tag" | "azure-tag";

interface ChannelKeys {
  readonly managedBy: string;
  readonly stack: string;
  readonly env: string;
}

const CHANNEL_KEYS: Record<OwnershipChannel, ChannelKeys> = {
  label: {
    managedBy: "app.kubernetes.io/managed-by",
    stack: "chant.intentius.io/stack",
    env: "chant.intentius.io/env",
  },
  "aws-tag": {
    managedBy: "chant:managed-by",
    stack: "chant:stack",
    env: "chant:env",
  },
  "azure-tag": {
    managedBy: "chant-managed-by",
    stack: "chant-stack",
    env: "chant-env",
  },
};

/** The marker key names used in a given channel. */
export function ownershipKeys(channel: OwnershipChannel): ChannelKeys {
  return CHANNEL_KEYS[channel];
}

/**
 * The key/value entries to stamp for a channel: the managed-by marker, the
 * stack identity, and the env identity when present.
 */
export function ownershipEntries(
  channel: OwnershipChannel,
  marker: OwnershipMarker,
): Record<string, string> {
  const keys = CHANNEL_KEYS[channel];
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
  channel: OwnershipChannel,
): boolean {
  if (!tagsOrLabels) return false;
  return tagsOrLabels[CHANNEL_KEYS[channel].managedBy] === OWNERSHIP_MANAGED_BY_VALUE;
}

/**
 * Read the stack/env identity from a marked resource's tags/labels. Returns
 * undefined when the managed-by marker is absent.
 */
export function readOwnership(
  tagsOrLabels: Record<string, unknown> | undefined,
  channel: OwnershipChannel,
): OwnershipMarker | undefined {
  if (!hasOwnershipMarker(tagsOrLabels, channel)) return undefined;
  const keys = CHANNEL_KEYS[channel];
  const stack = tagsOrLabels![keys.stack];
  const env = tagsOrLabels![keys.env];
  return {
    stack: typeof stack === "string" ? stack : "",
    env: typeof env === "string" ? env : undefined,
  };
}
