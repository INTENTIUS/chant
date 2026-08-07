/**
 * GCP deep-observation noise rules (#1209, #1210) — for REST payloads, not
 * Config Connector objects.
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
 *
 * ## The declared side is CNRM, and some of it never reaches GCP
 *
 * The declared tree is a Config Connector spec, and a few of its fields are
 * instructions to the CNRM machinery rather than resource configuration —
 * `projectRef`, `resourceID`, the `cnrm.cloud.google.com/*`
 * annotations. No REST payload will ever echo them (the project is in the
 * URL), so left alone each one reports `absent` drift on every clean apply.
 * They are pruned as declared-side envelope, the mirror image of the
 * live-side server fields.
 */
import type { DeepNode, DeepNormalizationHooks } from "@intentius/chant/deep-observation";
import { LABEL_OWNERSHIP_KEYS, type ChannelKeys } from "@intentius/chant/ownership";
import { GCP_RESOURCE_OWNERSHIP_KEYS } from "./ownership";
import { resolveGVK } from "./serializer";

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
  "projectId",
  "projectNumber",
  "timeCreated",
  "updated",
  "createTime",
  "updateTime",
  "generation",
  "metageneration",
  "uid",
  "uniqueId",
  "email",
  "state",
  "reconciling",
  "observedGeneration",
  // Cloud Run's server-computed service surface (v2 GetService).
  "uri",
  "urls",
  "conditions",
  "terminalCondition",
  "latestReadyRevision",
  "latestCreatedRevision",
]);

/**
 * Per-kind values GCP fills in when the request omits them, keyed by the
 * index-erased pattern from the tree root (the declared-props shape
 * `./deep-observe.ts` reshapes the live payload into — spec fields at the
 * root, so `storageClass`, not `spec.storageClass`).
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
    publicAccessPrevention: "inherited",
    uniformBucketLevelAccess: false,
    "softDeletePolicy.retentionDurationSeconds": "604800",
  },
  PubSubTopic: {
    "messageStoragePolicy.enforceInTransit": false,
  },
  PubSubSubscription: {
    ackDeadlineSeconds: 10,
    "expirationPolicy.ttl": "2678400s",
    enableMessageOrdering: false,
    enableExactlyOnceDelivery: false,
    retainAckedMessages: false,
    detached: false,
    "retryPolicy.minimumBackoff": "10s",
  },
  RunService: {
    ingress: "INGRESS_TRAFFIC_ALL",
    launchStage: "GA",
  },
  IAMServiceAccount: {
    disabled: false,
  },
};

/**
 * chant's own ownership marker, in both vocabularies it is written in: the
 * serializer stamps k8s-style label keys on the CNRM object
 * (`app.kubernetes.io/managed-by`), while `gcpApply` stamps the GCP-legal
 * equivalents on the live resource (`managed-by` — GCP label keys allow no `/`
 * or `.`). See `./ownership.ts` for why the two surfaces differ. A declared
 * tree carries the first family, a live payload can carry either (the applier
 * forwards the manifest's labels where a kind accepts labels at all), and
 * neither is drift: it is chant showing its own signature to itself — the same
 * correction #1301 made for AWS.
 */
const CHANT_OWNERSHIP_LABEL_PATTERNS: ReadonlySet<string> = new Set(
  [LABEL_OWNERSHIP_KEYS, GCP_RESOURCE_OWNERSHIP_KEYS].flatMap((keys: ChannelKeys) => [
    `metadata.labels.${keys.managedBy}`,
    `metadata.labels.${keys.stack}`,
    `metadata.labels.${keys.env}`,
  ]),
);

/** Declared-side CNRM machinery a REST payload never echoes (see module doc). */
const CNRM_ENVELOPE_PATTERNS: ReadonlySet<string> = new Set(["projectRef", "resourceID"]);
const CNRM_ANNOTATION_PREFIX = "metadata.annotations.cnrm.cloud.google.com/";

/** Last dotted segment of a path pattern — `spec.foo.etag` -> `etag`. */
function lastSegment(pattern: string): string {
  const i = pattern.lastIndexOf(".");
  return i === -1 ? pattern : pattern.slice(i + 1);
}

/** A `{}` with nothing pruned out of it, as GCP returns for an unset message. */
function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
  );
}

/**
 * GCP's static deep-observation noise rules, applied by core to the declared
 * tree and the live tree alike so the two are compared in the same shape.
 */
export const gcpDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    // Server-assigned, wherever it appears, on either side.
    if (GCP_READ_ONLY_NAMES.has(lastSegment(node.pattern))) return true;

    // chant's own ownership marker is not drift (see the set's doc).
    if (CHANT_OWNERSHIP_LABEL_PATTERNS.has(node.pattern)) return true;

    // CNRM machinery on the declared side: instructions to the controller, not
    // resource state, and no REST payload ever carries them.
    if (CNRM_ENVELOPE_PATTERNS.has(node.pattern)) return true;
    if (node.pattern.startsWith(CNRM_ANNOTATION_PREFIX)) return true;

    // Everything below subtracts provider-populated values from the live tree,
    // and only where source never declared the property. `counterpart` is a
    // tri-state; only `absent` licenses it.
    if (node.side !== "live" || node.counterpart !== "absent") return false;

    // An undeclared `null` or `{}` is GCP's spelling of "unset" — a field the
    // API includes in the payload without there being any configuration in it
    // (a service account's `description: null`, Cloud Run's
    // `binaryAuthorization: {}`).
    if (node.value === null || isEmptyObject(node.value)) return true;

    const kindDefaults = GCP_SERVICE_DEFAULTS[shortKind(node.entityType)];
    if (!kindDefaults) return false;
    return Object.prototype.hasOwnProperty.call(kindDefaults, node.pattern) && kindDefaults[node.pattern] === node.value;
  },
};

/**
 * `GCP::Pubsub::Topic` -> `PubSubTopic`, the key `GCP_SERVICE_DEFAULTS` uses —
 * the CNRM kind, resolved through the serializer's GVK map because the naive
 * `${service}${shortKind}` concatenation miscases 4 of the 6 appliable kinds
 * (`PubsubTopic`, `IamServiceAccount`, …) and silently matches no defaults.
 */
function shortKind(entityType: string): string {
  const resolved = resolveGVK(entityType);
  if (resolved) return resolved.kind;
  const parts = entityType.split("::");
  return parts.length === 3 ? `${parts[1]}${parts[2]}` : entityType;
}
