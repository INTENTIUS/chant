/**
 * The k8s lexicon's *static* deep-observation noise rules (#1076, epic #1073).
 *
 * Split out from `./deep-observe.ts` for one reason: this file must be safe
 * to import from `plugin.ts` at module load time, because
 * `LexiconPlugin.deepNormalizationHooks` is plain data core reads to
 * normalize the *declared* tree — the half of the contract that runs whether
 * or not a cluster is ever touched (`lifecycle diff` without `--live`,
 * `chant build`, tests that only exercise normalization). `./deep-observe.ts`
 * itself imports `@intentius/chant-k8s-client` for the live read, and chant
 * #1074 made that package's reachability from the build path a structural
 * property (`examples/k8s-client-boundary.test.ts`) rather than a lint rule —
 * so nothing this file exports may pull that package in, directly or
 * transitively. It imports the core contract's own types, and one generated
 * JSON data file (`./generated/list-map-keys.json`, chant #1441) — data, not a
 * package, so the boundary property is unchanged.
 *
 * What lives here is deliberately the *entityType-keyed, resource-agnostic*
 * half of the rules: which fields the API server always populates regardless
 * of what a manager wrote (`status`, `metadata.uid`, …), which fields
 * Kubernetes defaults when a manifest is silent about them, and which arrays
 * are sets addressed by a well-known identity (containers by name, ports by
 * containerPort+protocol). None of that needs a live object in hand.
 *
 * What does *not* live here is the managed-fields prune — whether one
 * specific field on one specific live object is chant-owned, foreign-owned,
 * or contested. That is inherently per-object (it depends on *that* object's
 * `metadata.managedFields`, which the declared tree never carries and which
 * differs between two Deployments of the same type), so it cannot be
 * expressed as a fixed rule keyed only by entity type and path — the shape
 * every other hook in this file takes. `./deep-observe.ts` computes it once
 * per resource and layers it on top of the rules below.
 *
 * The *entity-type-agnostic* half of these rules — which fields every
 * Kubernetes API object carries regardless of kind, and the well-known
 * list-map-key ordering conventions (containers/env/volumes/ports) — lives in
 * `@intentius/chant/managed-fields` (chant #1087), because a GCP Config
 * Connector custom resource is a Kubernetes object too and needs the exact
 * same rules without depending on this lexicon's package. What stays here is
 * only what's genuinely k8s-*lexicon*-specific: {@link K8S_SERVICE_DEFAULTS},
 * keyed by chant's own k8s entityType catalog.
 */

import { createRequire } from "module";
import type { DeepArrayElement, DeepNode, DeepNormalizationHooks } from "@intentius/chant/lexicon";
import { K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS, k8sListMapOrderKey } from "@intentius/chant/managed-fields";
import { LABEL_OWNERSHIP_KEYS, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";

// This module ships as ESM (tsx strips types from src/ directly), where a bare
// `require` is not defined — the same reason serializer.ts and the LSP modules
// already build one. The bug only surfaced on a LIVE deep read that meets an
// associative list (every k8s estate does: a Deployment's containers), so
// `lifecycle diff --live` crashed with `require is not defined` on exactly the
// estates the generated table exists for (#1441 regression, found on
// kubemicrovm-ops).
const require = createRequire(import.meta.url);

/**
 * Kubernetes-defaulted fields, per entity type, as index-erased property
 * paths. Subtracted only where source never declared the property
 * (`side === "live" && counterpart === "absent"`) — cdk-real-drift's default
 * subtraction, same convention as AWS/Azure/Temporal's tables.
 *
 * Sparse and evidence-based rather than derived from the generated schema:
 * the k8s OpenAPI spec this lexicon's codegen consumes
 * (`lexicons/k8s/src/spec/parse.ts`) does not carry a `default` value for
 * these fields the way ARM's schema sometimes does, so "per discovery" is not
 * actually expressible today. Widening this table is additive and needs no
 * contract change.
 *
 * `spec.strategy` is listed whole, not as `spec.strategy.type`, for the same
 * reason Temporal's `TEMPORAL_SCHEDULE_DEFAULTS` lists `state` whole: pruning
 * only the leaf would still recurse into the object, and a nested default the
 * table does not separately name (`rollingUpdate.maxSurge`/`maxUnavailable`,
 * both `"25%"` when `spec.strategy` is omitted entirely) would leave behind an
 * empty `strategy: {}` — a value distinct from no `strategy` key at all, and
 * itself a spurious "undeclared" finding. Matching the whole node first, before
 * its children are ever visited, drops the wrapper outright when every field
 * under it is exactly at its default.
 */
export const K8S_SERVICE_DEFAULTS: Record<string, Record<string, unknown>> = {
  "K8s::Apps::Deployment": {
    "spec.strategy": { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
    "spec.revisionHistoryLimit": 10,
    "spec.progressDeadlineSeconds": 600,
    "spec.template.spec.dnsPolicy": "ClusterFirst",
    "spec.template.spec.restartPolicy": "Always",
    "spec.template.spec.terminationGracePeriodSeconds": 30,
    "spec.template.spec.schedulerName": "default-scheduler",
    // Widened on the CC canonical estate (#1214): a container declaring an
    // httpGet probe, a named port, or nothing about termination gets exactly
    // these from the API server. SSA attributes a server-defaulted field to no
    // manager, so the managed-fields prune deliberately leaves them diffable
    // (see ./deep-observe.ts) — this table is where they subtract.
    "spec.template.spec.containers[].livenessProbe.failureThreshold": 3,
    "spec.template.spec.containers[].livenessProbe.periodSeconds": 10,
    "spec.template.spec.containers[].livenessProbe.successThreshold": 1,
    "spec.template.spec.containers[].livenessProbe.timeoutSeconds": 1,
    "spec.template.spec.containers[].livenessProbe.httpGet.scheme": "HTTP",
    "spec.template.spec.containers[].readinessProbe.failureThreshold": 3,
    "spec.template.spec.containers[].readinessProbe.periodSeconds": 10,
    "spec.template.spec.containers[].readinessProbe.successThreshold": 1,
    "spec.template.spec.containers[].readinessProbe.timeoutSeconds": 1,
    "spec.template.spec.containers[].readinessProbe.httpGet.scheme": "HTTP",
    "spec.template.spec.containers[].ports[].protocol": "TCP",
    "spec.template.spec.containers[].terminationMessagePath": "/dev/termination-log",
    "spec.template.spec.containers[].terminationMessagePolicy": "File",
    "spec.template.spec.securityContext": {},
  },
  "K8s::Core::Service": {
    "spec.sessionAffinity": "None",
    "spec.type": "ClusterIP",
    "spec.internalTrafficPolicy": "Cluster",
    "spec.ipFamilyPolicy": "SingleStack",
    "spec.ports[].protocol": "TCP",
  },
};

/**
 * Server-ASSIGNED fields — populated by the API server with a value that
 * varies per object (an allocated ClusterIP, the resolved IP family list), so
 * unlike {@link K8S_SERVICE_DEFAULTS} there is no fixed value to compare
 * against. Counterpart-gated like the defaults table: a declared `clusterIP`
 * is still compared, only the purely server-filled appearance is noise.
 */
export const K8S_SERVER_ASSIGNED_PATTERNS: Record<string, ReadonlySet<string>> = {
  "K8s::Core::Service": new Set(["spec.clusterIP", "spec.clusterIPs", "spec.ipFamilies"]),
};

/**
 * chant's own ownership marker, as label paths (#1214 — the k8s edition of
 * azure's #1213 rule). The build stamps `app.kubernetes.io/managed-by` +
 * `chant.intentius.io/{stack,env}` into every manifest it emits, so a managed
 * object always carries them live while the declared *source* the diff
 * compares does not — chant reading its own signature back as drift. The
 * managed-fields prune cannot subtract them: they are in the applied config,
 * so chant's field manager owns them, and chant-owned is always diffable.
 * Counterpart-gated at the call site; managed-by is additionally gated on the
 * value `"chant"`, so `managed-by: helm` appearing out of band still surfaces.
 */
const K8S_OWNERSHIP_LABEL_PATTERNS: ReadonlySet<string> = new Set([
  `metadata.labels.${LABEL_OWNERSHIP_KEYS.stack}`,
  `metadata.labels.${LABEL_OWNERSHIP_KEYS.env}`,
]);

const K8S_MANAGED_BY_LABEL_PATTERN = `metadata.labels.${LABEL_OWNERSHIP_KEYS.managedBy}`;

/** Stable JSON with sorted keys — the fallback ordering key for a set-like array without a natural identity field. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ""
  );
}

/**
 * The k8s lexicon's static noise rules: the generic Kubernetes object
 * envelope (unconditional, by pattern, `@intentius/chant/managed-fields`) and
 * Kubernetes-defaulted fields (gated on `counterpart === "absent"`), plus the
 * array orderings.
 *
 * The orderings are now taken from the spec itself (chant #1441): codegen
 * carries `x-kubernetes-list-type`/`x-kubernetes-list-map-keys` through into
 * `./generated/list-map-keys.json`, and {@link schemaListMapOrderKey} reads
 * it. The hand-written conventions in
 * `@intentius/chant/managed-fields`'s `k8sListMapOrderKey` — containers by
 * `name`, `env` by `name`, `volumes` by `name`, container/service `ports` by
 * `containerPort`/`port` + `protocol` — remain as the fallback for lists the
 * spec does not annotate, and for readers that have no generated table at all
 * (GCP's Config Connector hooks).
 *
 * This is the object `k8sPlugin.deepNormalizationHooks` is. It is also what
 * `./deep-observe.ts` layers its per-resource managed-fields prune on top of,
 * so the two normalization passes (the reader's own, and core's later
 * re-normalization of both the declared and the already-normalized live tree
 * — see `packages/core/src/lifecycle/deep-observe.ts`) apply the identical
 * entityType-keyed rules either way.
 */
/** Property name → candidate key-field sets, generated from the spec (chant #1441). */
type ListMapKeyTable = Record<string, string[][]>;

let cachedListMapKeys: ListMapKeyTable | undefined;

function listMapKeyTable(): ListMapKeyTable {
  cachedListMapKeys ??= require("./generated/list-map-keys.json") as ListMapKeyTable;
  return cachedListMapKeys;
}

/** Last dotted segment of an index-erased path: `spec.template.spec.containers` → `containers`. */
function lastSegment(pattern: string): string {
  const at = pattern.lastIndexOf(".");
  return at === -1 ? pattern : pattern.slice(at + 1);
}

/**
 * Render one key field's value into a sort key fragment. Numbers are
 * zero-padded so the key orders numerically rather than lexicographically —
 * `"443"` would otherwise sort before `"80"`. Cosmetic, since either order
 * canonicalizes the two sides identically, but a human-sensible order is free
 * to have here (the same reasoning `k8sListMapOrderKey` applies to ports).
 */
function keyFragment(value: unknown): string {
  if (typeof value === "number") return String(value).padStart(5, "0");
  return typeof value === "string" ? value : canonicalJson(value);
}

/**
 * Join a key set's values the way `k8sListMapOrderKey` already does: the bare
 * values, `/`-separated, with no field names.
 *
 * This is not only a sort key. Core renders it as the element's ADDRESS in
 * drift output — `spec.template.spec.containers[#app].image` — so the format
 * is user-visible and load-bearing. Emitting `name=app` here would rewrite
 * every existing drift path. Bare values keep the six properties that were
 * hardcoded byte-identical, and extend to the rest for free: a container port
 * reads `[#08080/TCP]` exactly as before, a condition reads `[#Ready]`.
 */
function joinKeyValues(el: Record<string, unknown>, keys: string[]): string {
  return keys.map((k) => keyFragment(el[k])).join("/");
}

/**
 * Order an associative list's element by the identity the SPEC declares for it
 * (chant #1441), falling back to `@intentius/chant/managed-fields`'s hand-written
 * conventions for anything the generated table does not cover.
 *
 * The fallback is not vestigial. The table is built from the properties this
 * lexicon's codegen parsed, so it covers core Kubernetes and any CRD that
 * declares the extensions — but a CRD that declares an associative list
 * WITHOUT `x-kubernetes-list-map-keys`, or a Config Connector resource read
 * through GCP's hooks, still lands on the by-name conventions. Keeping both
 * means widening the spec-derived table can never narrow what was already
 * identified.
 */
export function schemaListMapOrderKey(element: DeepArrayElement): string | undefined {
  const candidates = listMapKeyTable()[lastSegment(element.pattern)];
  const el = element.element;

  if (candidates && isRecordLike(el)) {
    for (const keys of candidates) {
      if (!keys.every((k) => el[k] !== undefined)) continue;
      return joinKeyValues(el, keys);
    }
  }

  return k8sListMapOrderKey(element);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const k8sDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    if (K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS.has(node.pattern)) return true;

    if (node.side !== "live" || node.counterpart !== "absent") return false;

    // chant's own ownership marker is not drift (see the sets' docs).
    if (K8S_OWNERSHIP_LABEL_PATTERNS.has(node.pattern)) return true;
    if (node.pattern === K8S_MANAGED_BY_LABEL_PATTERN && node.value === OWNERSHIP_MANAGED_BY_VALUE) return true;

    // A server-assigned value nobody declared is allocation, not drift.
    if (K8S_SERVER_ASSIGNED_PATTERNS[node.entityType]?.has(node.pattern)) return true;

    const defaults = K8S_SERVICE_DEFAULTS[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return canonicalJson(defaults[node.pattern]) === canonicalJson(node.value);
  },

  orderKey: schemaListMapOrderKey,
};
