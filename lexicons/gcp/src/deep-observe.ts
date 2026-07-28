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
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { classifyKubectlFailure } from "@intentius/chant/kubectl-context";
import { buildOwnershipSets, pruneByOwnership, type OwnershipSets, type ManagedFieldsEntryLike } from "@intentius/chant/managed-fields";
import { deriveGVK, execConfigConnectorGet, resolveGcpKubectlContext } from "./describe-resources";
import { gcpDeepNormalizationHooks } from "./deep-observe-hooks";

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
 * Matches chant's field-manager naming scheme (chant #1075: bare `chant`, or
 * `chant:<stack>`) — the same convention `@intentius/chant-k8s-client`'s
 * `isChantFieldManager` checks. Restated here rather than imported: gcp must
 * never depend on that package (chant #1074/#1177's structural boundary — the
 * k8s lexicon reads live cluster state through a typed client, gcp shells
 * kubectl, and the two stay independently deployable). This is a two-branch
 * string comparison with nothing to drift out of sync; the piece that
 * genuinely could — the managed-fields ownership walk — is shared through
 * `@intentius/chant/managed-fields`, not reimplemented here. See the module
 * doc for why this rarely matches anything on GCP's real deploy path today,
 * and why that's fine.
 */
function isGcpChantFieldManager(manager: string | undefined): boolean {
  if (!manager) return false;
  return manager === "chant" || manager.startsWith("chant:");
}

/**
 * The managed-fields prune, composed with the static rules, for one
 * resource's normalization call — the same layering k8s's `perResourceHooks`
 * uses, sharing the actual rule (`pruneByOwnership`) rather than restating it.
 */
function perResourceHooks(sets: OwnershipSets): DeepNormalizationHooks {
  return {
    prune(node) {
      if (gcpDeepNormalizationHooks.prune?.(node)) return true;
      return pruneByOwnership(node, sets);
    },
    orderKey: gcpDeepNormalizationHooks.orderKey,
  };
}

/** `metadata.managedFields` off a raw `kubectl get -o json` object — a plain decode, no client-side type coercion. */
function managedFieldsOfRaw(obj: Record<string, unknown>): ManagedFieldsEntryLike[] {
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const entries = (metadata as Record<string, unknown>).managedFields;
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is ManagedFieldsEntryLike => !!e && typeof e === "object");
}

/** The live object minus the envelope fields that live outside `properties` on {@link DeepResourceObservation} (mirrors k8s's `propertiesTreeOf`). */
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

  // Resolve the cluster identity once, before touching any resource — a
  // declared-but-mismatched binding throws here (chant #1100), aborting the
  // whole read rather than letting the per-entity try/catch below absorb it
  // as an ordinary "not found". Core turns the throw into NOT-OBSERVED for
  // every declared entity.
  const ctxArg = await resolveGcpKubectlContext(options.environment);

  for (const [entityName, { entityType, props }] of options.entities) {
    const gvk = deriveGVK(entityType);
    if (!gvk) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `cannot derive a Config Connector GVK from ${entityType}`,
      };
      continue;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      continue;
    }

    try {
      const obj = await execConfigConnectorGet(gvk, name, metadata.namespace, ctxArg);
      const objMetadata = obj.metadata as { labels?: Record<string, string>; uid?: string } | undefined;

      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (#1089) — the CR exists, it just isn't chant's.
      if (options.owned && !hasOwnershipMarker(objMetadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live resource carries no chant ownership marker and --owned was requested",
        };
        continue;
      }

      const liveRoot = propertiesTreeOf(obj);
      const sets = buildOwnershipSets(managedFieldsOfRaw(obj), liveRoot, props, isGcpChantFieldManager);

      resources[entityName] = {
        type: entityType,
        physicalId: objMetadata?.uid,
        properties: normalizeDeepProperties(liveRoot, {
          entityType,
          side: "live",
          hooks: perResourceHooks(sets),
        }),
      };
    } catch (err) {
      // A NotFound is a real absence, same as the thin read — records
      // nothing here, since restating it would turn one finding into two.
      // Anything else (auth, connectivity, a mismatched context) proves
      // nothing and is a hole rather than an absence (#1089).
      const outcome = classifyKubectlFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
    }
  }

  return deepObservation(resources, unobserved);
}
