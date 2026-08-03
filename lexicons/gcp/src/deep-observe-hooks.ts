/**
 * GCP deep-observation noise rules (#1209) — for REST payloads, not Config
 * Connector objects.
 *
 * ## What this replaced, and why it had to
 *
 * Until #1209 the deep reader read Config Connector custom resources through
 * kubectl, and suppressed noise two ways: this module's static rules (the k8s
 * object envelope plus CNRM's own observed-state annotations) and, in
 * `./deep-observe.ts`, a per-resource prune driven by `metadata.managedFields`
 * — Kubernetes records which manager owns which field, so everything the CNRM
 * controller owned was subtracted before the diff ran.
 *
 * Reading GCP's own REST APIs removes both. **A GCP payload never says who
 * wrote a field**, so there is no managed-fields attribution to prune by, and
 * it is not a Kubernetes object, so the k8s envelope and CNRM annotation rules
 * match nothing in it. Audited every rule that was here: all of them were
 * CNRM-shaped, none applies.
 *
 * So the noise story is re-answered rather than re-pointed, in the shape the
 * other two cloud lexicons already use — a static table naming what the
 * provider populates. It is hand-maintained, which is the honest cost: a
 * server-set field nobody has listed reads as drift until it is. That is
 * visible and fixable, where an over-broad rule silently hides real drift.
 */
import type { DeepNode, DeepNormalizationHooks } from "@intentius/chant/deep-observation";

/**
 * Fields GCP populates on essentially anything, wherever they appear.
 *
 * Pruned on BOTH sides and regardless of whether source declared them: these
 * are server-assigned identity and bookkeeping, and a user who writes one is
 * writing something the API will overwrite anyway.
 */
export const GCP_READ_ONLY_NAMES: ReadonlySet<string> = new Set([
  "etag",
  "selfLink",
  "id",
  "projectNumber",
  "timeCreated",
  "updated",
  "createTime",
  "updateTime",
  "generation",
  "metageneration",
  "uid",
  "state",
  "reconciling",
  "observedGeneration",
]);

/**
 * Per-kind values GCP fills in when the request omits them.
 *
 * Unlike {@link GCP_READ_ONLY_NAMES} these are only noise where **source never
 * declared the property** — a default somebody explicitly wrote is a fact worth
 * diffing, and pruning it would hide a real change away from it. The
 * `counterpart === "absent"` gate below is what enforces that, and it is the
 * same rule the AWS and Azure hooks apply.
 */
export const GCP_SERVICE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  StorageBucket: {
    storageClass: "STANDARD",
    locationType: "multi-region",
    "iamConfiguration.publicAccessPrevention": "inherited",
    "iamConfiguration.uniformBucketLevelAccess.enabled": false,
    "softDeletePolicy.retentionDurationSeconds": "604800",
    kind: "storage#bucket",
  },
  PubSubTopic: {
    "messageStoragePolicy.enforceInTransit": false,
  },
  PubSubSubscription: {
    ackDeadlineSeconds: 10,
    "expirationPolicy.ttl": "2678400s",
    enableMessageOrdering: false,
    "retryPolicy.minimumBackoff": "10s",
  },
  SecretManagerSecret: {
    etag: undefined, // covered by READ_ONLY; listed for readers looking here first
  },
  RunService: {
    ingress: "INGRESS_TRAFFIC_ALL",
    launchStage: "GA",
  },
  IAMServiceAccount: {
    disabled: false,
  },
};

/** chant's own ownership labels, as the applier stamps them. */
const CHANT_OWNERSHIP_LABEL_PATTERNS: ReadonlySet<string> = new Set([
  "metadata.labels.managed-by",
  "metadata.labels.chant-stack",
  "metadata.labels.chant-env",
]);

/** Last dotted segment of a path pattern — `spec.foo.etag` -> `etag`. */
function lastSegment(pattern: string): string {
  const i = pattern.lastIndexOf(".");
  return i === -1 ? pattern : pattern.slice(i + 1);
}

/**
 * GCP's static deep-observation noise rules, applied by core to the declared
 * tree and the live tree alike so the two are compared in the same shape.
 */
export const gcpDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    // Server-assigned, wherever it appears, on either side.
    if (GCP_READ_ONLY_NAMES.has(lastSegment(node.pattern))) return true;

    // chant's own ownership marker is not drift. The applier stamps these, so
    // reporting them back is chant showing its own signature to itself — the
    // same correction #1301 made for AWS after the emulator began applying tags.
    if (CHANT_OWNERSHIP_LABEL_PATTERNS.has(node.pattern)) return true;

    // A provider default is noise only where source never declared the
    // property. `counterpart` is a tri-state; only `absent` licenses this.
    if (node.side !== "live" || node.counterpart !== "absent") return false;
    const kindDefaults = GCP_SERVICE_DEFAULTS[shortKind(node.entityType)];
    if (!kindDefaults) return false;
    return Object.prototype.hasOwnProperty.call(kindDefaults, node.pattern) && kindDefaults[node.pattern] === node.value;
  },
};

/** `GCP::Storage::Bucket` -> `StorageBucket`, the key `GCP_SERVICE_DEFAULTS` uses. */
function shortKind(entityType: string): string {
  const parts = entityType.split("::");
  return parts.length === 3 ? `${parts[1]}${parts[2]}` : entityType;
}
