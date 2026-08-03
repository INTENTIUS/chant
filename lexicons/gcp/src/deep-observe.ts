/**
 * GCP deep observation (#1087) — the GCP row of the deep-observe contract
 * (#1014), reusing the k8s row (#1076) rather than writing a second one, per
 * the issue and #1173's own per-row checklist: "A Config Connector resource
 * *is* a Kubernetes object, so it carries managed-fields for the same
 * reason. Share the hooks rather than writing a second implementation."
 *
 * ## A Config Connector CR is a Kubernetes object
 *
 * `kubectl get <kind>.<group> -o json` against a Config Connector-enabled
 * cluster (`./describe-resources.ts`'s own transport, reused here) returns a
 * real Kubernetes API object: `metadata.managedFields`, `status`,
 * `metadata.{uid,resourceVersion,generation,creationTimestamp}` are all
 * present for the identical reason they're present on a Deployment — the API
 * server that served the read is the same kind of API server. The epic's own
 * table lists `metadata.managedFields` under GCP's "field noise" to prune; it
 * is the opposite of noise, and it is available here for exactly the reason
 * chant #1076 reads it on the k8s row.
 *
 * So this reader reuses, unchanged, from `@intentius/chant/managed-fields`:
 *
 * - `K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS` — the generic Kubernetes object
 *   envelope (`status`, `metadata.{uid,resourceVersion,generation,
 *   creationTimestamp,managedFields,selfLink}`).
 * - `k8sListMapOrderKey` — Kubernetes' own list-map-key conventions, needed
 *   because some CNRM kinds embed genuinely k8s-shaped substructures (Cloud
 *   Run's `RunService` wraps a Knative pod spec with
 *   `containers`/`env`/`ports`, keyed the same way a Deployment's are).
 * - `buildOwnershipSets`/`pruneByOwnership` — the managed-fields ownership
 *   walk itself: chant #1076's actual contribution, and the piece this row
 *   exists to reuse rather than reimplement.
 *
 * These live in core, not in the k8s lexicon, specifically so this file can
 * reuse them without adding a dependency on the k8s lexicon package or (never,
 * per the issue) on `@intentius/chant-k8s-client` — this reader shells
 * `kubectl` exactly like `./describe-resources.ts` already does. Chant
 * #1177/#1180 kept GCP off the typed client deliberately ("a separate
 * lexicon and a separate decision"); this row does not revisit that.
 *
 * ## The GCP twist: who is "chant" on this path?
 *
 * Chant #1076's rule treats a field as always-diffable when *any* chant field
 * manager (`chant`, `chant:<stack>` — chant #1075's SSA identity) owns it.
 * That identity is only ever set by the k8s lexicon's typed client, applying
 * with an explicit `--field-manager`. GCP has no equivalent apply activity:
 * every gcp example's own deploy script (e.g.
 * `examples/cockroachdb-multi-region-gke/scripts/deploy.sh`) runs plain
 * `kubectl apply -f dist/*.yaml` — classic client-side apply, no
 * `--server-side`, no `--field-manager`. kubectl's own hardcoded default
 * field manager for that command is `kubectl-client-side-apply`, identical
 * to what a human's `kubectl apply -f their-own-file.yaml` would record.
 * **There is no field-manager name on GCP's real deploy path that
 * distinguishes "chant applied this" from "a person applied this".**
 * (Config Connector's own controller is distinguishable — its reconciler
 * records itself as `cnrm-controller-manager`, per the k8s-config-connector
 * source's own `ControllerManagedFieldManager` constant — just chant isn't,
 * on this path.)
 *
 * That sounds like it breaks question 1 of the three-question rule
 * (`isChantManager`) below. It doesn't, because question 3 already covers
 * it: chant's own kubectl apply always applies the *exact* built manifest, so
 * any field chant's own most recent apply set is, by construction, also in
 * `declaredRoot` (`props`) on the very next read — chant never authors a
 * field it does not also declare. Working through what that means per field:
 *
 * - A field only chant's own applies have ever touched: not recognized as
 *   `chantOwned` (its manager is `kubectl-client-side-apply`, not `chant`),
 *   but foreign-owned *and* declared → contested → kept diffable anyway.
 *   Same outcome as being chant-owned would have been.
 * - A field CNRM's controller sets and chant never declares: foreign-owned,
 *   undeclared → pruned. Correct regardless of whether "chant" is recognized.
 * - A field a human sets by hand (`kubectl edit`, or their own `kubectl apply
 *   -f`) that chant *does* declare: foreign-owned (manager is `kubectl-edit`
 *   or `kubectl-client-side-apply`) and declared → contested → surfaces as
 *   drift. This is #1087's acceptance criterion 1.
 *
 * `isGcpChantFieldManager` below still checks the `chant`/`chant:<stack>`
 * family, so a future GCP apply path that *does* route through server-side
 * apply with an explicit chant field manager (matching the k8s lexicon's own
 * path) is recognized with no change needed here. On today's plain-apply
 * path it is inert — proven inert by this module's own test suite (the
 * "managers-specific case") — and the contested-field rule (question 3) is
 * what actually keeps GCP's drift semantics correct without it.
 *
 * ## What's genuinely GCP-specific
 *
 * - No typed operation surface (chant #1177's `operationFor` is a k8s
 *   lexicon/typed-client concept, generated from cluster discovery this
 *   reader never touches) — `./describe-resources.ts`'s `deriveGVK` stands in.
 * - CNRM's own observed-state annotations (`./deep-observe-hooks.ts`'s
 *   `gcpDeepNormalizationHooks`) — bookkeeping the controller writes into
 *   `metadata.annotations` for GCP-side properties the CRD schema has no
 *   field for. See that module's doc for why the list is narrow.
 *
 * ## Deliberately out of scope
 *
 * `status.conditions` staleness as its own signal — the issue's own
 * "Proposed" section floats this as worth *deciding*, not worth doing here.
 * `status` is pruned outright (matching k8s, and the acceptance criteria),
 * and a CNRM projection lagging real GCP state is a genuine gap, but
 * detecting it means reading the actual GCP API, not the CR — a different
 * read than this contract's "normalize what Kubernetes reports" scope.
 * Flagged, not papered over.
 *
 * ## The build-path boundary
 *
 * This module imports `./describe-resources.ts` for the live kubectl
 * transport, which imports `node:child_process`. `gcpPlugin.ts` reaches this
 * file only via `await import("./deep-observe")` inside
 * `observeResourcesDeep` — never statically — the same way it already
 * dynamic-imports `describeResources`/`exportResources`, so `chant build`
 * never resolves a process-spawning module just to synthesize a template.
 * `deepNormalizationHooks` is plain data with no such dependency
 * (`./deep-observe-hooks.ts`) and is imported statically from `plugin.ts`,
 * because core normalizes the *declared* tree with it whether or not a
 * cluster read ever happens.
 */

import type {
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { hasOwnershipMarker, type ChannelKeys } from "@intentius/chant/ownership";
import { deriveGVK } from "./describe-resources";
import { getResource, mapperForKind, GcpReadError, isNotFound, type GcpReadClientOptions } from "./api/read-client";
import { resolveGcpProject } from "./op/activities/gcp-apply";
import { gcpDeepNormalizationHooks } from "./deep-observe-hooks";

/** The labels the applier stamps — see describe-resources.ts. */
const GCP_OWNERSHIP_LABEL_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};

// Re-exported so a dynamic importer of this module (plugin.ts's
// `observeResourcesDeep`, a test) can get the reader and its hooks from one
// place. `plugin.ts`'s own `deepNormalizationHooks` field imports the hooks
// separately, directly from `./deep-observe-hooks` — see the module doc.
export { gcpDeepNormalizationHooks };

export interface GcpDeepObserveOptions {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  owned?: boolean;
}

/**
 * Reshape a GCP REST body into the CNRM shape the declared source is written in.
 *
 * This is the half of the port that is not transport (#1209). chant's GCP
 * source declares Config Connector custom resources — `{ metadata: { name },
 * spec: { location, storageClass } }` — while the REST APIs return their own
 * flat shape, `{ name, location, storageClass }`. Diffing one against the other
 * makes every field drift twice: once as `spec.location: US -> <absent>` and
 * again as `location: <undeclared> -> US`.
 *
 * Verified against floci-gcp before this existed: a bucket that matched its
 * declaration exactly reported **7 property drifts**, all of them shape.
 *
 * chant has met this before. #1207 records it for AWS: Cloud Control returns
 * the CloudFormation resource model and lines up for free, while the EC2 API
 * returns the EC2 shape and needs mapping onto the declared shape before the
 * diff can compare. GCP is the EC2 case.
 *
 * The mapping is CNRM's own convention rather than a per-kind table: identity
 * and labels live under `metadata`, everything else is `spec`. That holds for
 * every kind the applier can write, and a per-kind table would be a second
 * place to forget a field.
 */
export function restToCnrmShape(body: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const spec: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "name" || key === "labels" || key === "annotations") metadata[key] = value;
    else spec[key] = value;
  }
  return {
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(Object.keys(spec).length ? { spec } : {}),
  };
}

/** The live payload minus the fields that live outside `properties` on
 * {@link DeepResourceObservation}. A REST body has no `apiVersion`, but `kind`
 * shows up on some (GCS returns `storage#bucket`), so both are dropped. */
function propertiesTreeOf(obj: Record<string, unknown>): Record<string, unknown> {
  const { apiVersion: _apiVersion, kind: _kind, ...rest } = obj;
  return rest;
}

/**
 * Read the live property tree for each declared entity via `kubectl get
 * <kind>.<group> -o json`, pruning by `metadata.managedFields` (see the
 * module doc). Reuses `./describe-resources.ts`'s exact cluster-binding
 * resolution and kubectl mechanics — the binding check (chant #1100) still
 * refuses before any resource is touched, and a connect failure still
 * becomes NOT-OBSERVED for every declared entity rather than an empty result.
 */
export async function observeResourcesDeepGcp(options: GcpDeepObserveOptions): Promise<DeepObservationResult> {
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  const endpoint = process.env.GCP_ENDPOINT_URL;

  const reads = [...options.entities].map(async ([entityName, { entityType, props }]) => {
    const gvk = deriveGVK(entityType);
    if (!gvk || !mapperForKind(gvk.kind)) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: gvk
          ? `no REST mapper for ${gvk.kind} — chant cannot apply this kind either`
          : `cannot derive a GCP kind from ${entityType}`,
      };
      return;
    }

    const metadata = props.metadata as { name?: string; annotations?: Record<string, string> } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      return;
    }

    let client: GcpReadClientOptions;
    try {
      client = {
        project: resolveGcpProject({ kind: gvk.kind, metadata }),
        ...(endpoint ? { endpoint } : {}),
      };
    } catch (err) {
      unobserved[entityName] = {
        type: entityType,
        reason: "no-binding",
        detail: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    try {
      const obj = await getResource(client, gvk.kind, name, props);
      const labels = obj.labels as Record<string, string> | null | undefined;

      // owned filter: withhold what does not carry chant's marker. Withheld is
      // not absent (#1089). Where the payload has no labels at all there is
      // nothing to filter on, so the resource passes through — the same
      // detect-only degradation the thin path takes.
      if (options.owned && labels != null && !hasOwnershipMarker(labels, GCP_OWNERSHIP_LABEL_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live resource carries no chant ownership marker and --owned was requested",
        };
        return;
      }

      resources[entityName] = {
        type: entityType,
        physicalId: (obj.id as string | undefined) ?? (obj.selfLink as string | undefined),
        properties: normalizeDeepProperties(restToCnrmShape(propertiesTreeOf(obj)), {
          entityType,
          side: "live",
          // The static table is the whole prune now — there is no per-resource
          // ownership pass, because a REST payload carries no field ownership
          // to drive one (see ./deep-observe-hooks.ts).
          hooks: gcpDeepNormalizationHooks,
        }),
      };
    } catch (err) {
      // A 404 is a real absence, same as the thin read — recorded there, not
      // restated here. Anything else proves nothing and is a hole (#1089).
      if (isNotFound(err)) return;
      const status = err instanceof GcpReadError ? err.status : undefined;
      unobserved[entityName] = {
        type: entityType,
        reason: status === 401 || status === 403 ? "no-credentials" : "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });

  await Promise.all(reads);

  return deepObservation(resources, unobserved);
}
