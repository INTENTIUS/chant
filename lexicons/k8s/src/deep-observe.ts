/**
 * Kubernetes deep observation (#1076) — the k8s row of the deep-observe
 * contract (#1014), and the epic's (#1073) thesis made real: chant compiled
 * the manifest, so it knows which fields it authored; the API server records,
 * per field, which manager last wrote it (`metadata.managedFields`, chant
 * #1075/#1178). Intersecting those two makes Kubernetes drift *derived*
 * rather than the hand-maintained `ignoreDifferences` list every Argo user
 * keeps.
 *
 * ## Why this is not "the AWS reader, with `kubectl get` instead of Cloud
 * Control"
 *
 * AWS, Azure and Temporal's rows all prune by a **static, entityType-keyed**
 * table: an ARN always looks like an ARN, `provisioningState` is always
 * server-populated, a namespace's retention default is always the same
 * value. None of that needs the specific live object in hand — it is exactly
 * what `./deep-observe-hooks.ts`'s `k8sDeepNormalizationHooks` is, and it
 * covers Kubernetes' *equivalent* static noise (`status`,
 * `metadata.{uid,resourceVersion,generation,creationTimestamp}`, a handful of
 * server-defaulted pod-spec fields).
 *
 * managedFields is not that kind of rule. Whether `spec.replicas` is noise on
 * *this* Deployment depends on whether *this* Deployment's
 * `metadata.managedFields` says a controller owns it — a fact that differs
 * between two Deployments of the same type, and that the declared tree never
 * carries at all (chant's source has no `managedFields` key to normalize).
 * `DeepNormalizationHooks.prune` cannot see the object it is walking, only a
 * path and a value, so this cannot be expressed as a fixed hook the way the
 * other three rows' entire contribution is. It has to be computed once per
 * resource, here, and layered on top of the static rules before the tree is
 * normalized.
 *
 * ## The contested-field rule, precisely
 *
 * For every path on the live tree, three questions, each independent:
 *
 * 1. **Does any chant field manager (`chant`, `chant:<stack>` — chant #1075,
 *    matched on the family so a stack rename does not stop recognizing its
 *    own history) own this path?** If so it is chant's business regardless of
 *    what else is true — always diffable, never pruned by this rule.
 * 2. **Does some *other* manager own this path, and chant does not?** That is
 *    controller-managed noise — HPA rewriting `spec.replicas`, a mutating
 *    webhook defaulting a field, `kubectl-client-side-apply` from a human
 *    operator — *provided* nobody declared it (next question). Prune it.
 * 3. **Does chant's own manifest *also* set this path?** — independent of
 *    who currently owns it live. This is the case the issue calls out by
 *    name: **a contested field chant declared is drift-relevant.** The
 *    reasoning: chant's source is a statement of intent regardless of
 *    whether a previous apply is what currently holds the field, and a
 *    foreign write that overrides a value chant's manifest asks for is
 *    exactly the thing `lifecycle diff --live` exists to surface — silencing
 *    it because *something else* currently owns the field would hide the one
 *    case where chant and the cluster disagree about a property chant is
 *    actively declaring. So: foreign-owned *and* declared is never pruned by
 *    this rule, whatever #2 would otherwise do.
 *
 * `counterpart: "unknown"` and why it does not help here: core's own
 * counterpart tri-state (`side === "live" && counterpart === "absent"`, what
 * {@link K8S_SERVICE_DEFAULTS} is gated on) answers "did the *declared tree*
 * carry this path at all" — which is exactly question 3, but it is computed
 * by *core*, from the raw declared and raw live trees, only on the **second**
 * normalization pass (`packages/core/src/lifecycle/deep-observe.ts`'s
 * `diffDeepObservation`). This reader's own call to
 * {@link normalizeDeepProperties} runs first, with no `counterpartPaths`
 * supplied — same as the other three rows — so `counterpart` is `"unknown"`
 * for every node here, and a rule gated on `"absent"` would never fire during
 * this read at all. That is fine for a table keyed only by entityType (AWS's
 * service defaults are subtracted on core's later pass, not this one), but it
 * is *not* fine for the managed-fields rule: if this reader left
 * `spec.replicas` in the tree waiting for core's second pass to prune it,
 * core would be normalizing with the *static* `k8sDeepNormalizationHooks`,
 * which has no managedFields for this object in hand either (this reader
 * already computed its ownership sets from data it read once and does not
 * return). So question 3 is answered **here**, directly against the declared
 * `props` this reader was handed — not via `counterpart` — and the result is
 * baked into what this reader returns: a foreign-owned, undeclared field is
 * gone from the tree before it ever reaches core, and a contested one is
 * still there for the ordinary declared-vs-live comparison to catch.
 *
 * ## Resolving a managedFields entry against a live array
 *
 * `metadata.managedFields[].fieldsV1` encodes a list item three ways —
 * `k:{"name":"web"}` (by key), `v:"blue"` (by value), `i:3` (by index) — and
 * chant #1178's `managed-fields.ts` renders all three to a path *string*
 * (`.spec.containers[name="web"]`) for display. Parsing that string back
 * would be ambiguous in general (a label key may itself contain `.`, e.g.
 * `app.kubernetes.io/name`, indistinguishable in the rendered form from
 * nested fields), so this reader does not parse strings at all: it walks the
 * *structured* `fieldsV1` tree directly (`walkOwnership`, below), matching
 * each `k:`/`v:` entry against the actual live array to find the concrete
 * index, and against the actual declared array (by the same key or value) to
 * answer question 3 for that element specifically — a declared container
 * named `app` at index 0 is still "declared" if a sidecar gets injected in
 * front of it and shifts it to live index 1.
 *
 * ## What is deliberately not modeled
 *
 * A manager's `.` entry (SSA's "I own this element's presence") on a
 * container that also sets no scalar sub-fields (unusual — a real apply
 * setting a container almost always sets `image`/`name` too) would not confer
 * ownership onto a sibling field nobody's `fieldsV1` entry lists explicitly.
 * That is the conservative direction: a path absent from every manager's
 * fields is treated as "no ownership information", which leaves it diffable
 * rather than silently pruned. Reported drift that turns out to be more
 * noise than expected is a tuning problem; drift silently dropped is not.
 *
 * ## `buildOwnershipSets` lives in core now
 *
 * The ownership walk itself (`walkOwnership`, resolving a `fieldsV1` tree
 * against the live and declared trees) has nothing k8s-*lexicon*-specific
 * about it — it is generic Kubernetes SSA machinery. Chant #1087 (GCP's row,
 * reusing this one, since a Config Connector CR is a Kubernetes object too)
 * moved it to `@intentius/chant/managed-fields` rather than have gcp depend
 * on this lexicon's package, the same reason chant #1100's
 * `resolveClusterTarget` lives in core. This module re-exports
 * `buildOwnershipSets`/`OwnershipSets` from there so nothing here changes for
 * an existing importer of this file.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import type {
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { buildOwnershipSets, pruneByOwnership, type OwnershipSets } from "@intentius/chant/managed-fields";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import {
  classifyApiFailure,
  isMissingClientPackage,
  isWholeLexiconFailure,
  MISSING_CLIENT_DETAIL,
} from "./api/classify";
import { operationFor } from "./api/operation-surface";
import { k8sDeepNormalizationHooks } from "./deep-observe-hooks";

// Re-exported so a dynamic importer of this module (plugin.ts's
// `observeResourcesDeep`, a test) can get the reader and its hooks from one
// place, the same shape AWS/Azure/Temporal's single deep-observe.ts offers.
// `plugin.ts`'s own `deepNormalizationHooks` field imports the hooks
// separately, directly from `./deep-observe-hooks` — that file has no
// dependency on `@intentius/chant-k8s-client`, so it is safe to import
// statically; this module is not (see the module doc).
export { k8sDeepNormalizationHooks, buildOwnershipSets, type OwnershipSets };

export interface K8sDeepObserveOptions {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  owned?: boolean;
  /** Directory whose `chant.config.ts` carries the cluster binding. Defaults to cwd. */
  cwd?: string;
}

/**
 * The managed-fields prune, composed with the static rules, for one
 * resource's normalization call. See the module doc for the three-question
 * rule this encodes (`@intentius/chant/managed-fields`'s `pruneByOwnership`).
 */
function perResourceHooks(sets: OwnershipSets): DeepNormalizationHooks {
  return {
    prune(node) {
      if (k8sDeepNormalizationHooks.prune?.(node)) return true;
      return pruneByOwnership(node, sets);
    },
    orderKey: k8sDeepNormalizationHooks.orderKey,
  };
}

/** The live object minus the envelope fields that live outside `properties` on {@link DeepResourceObservation} (mirrors `type`/`physicalId`). */
function propertiesTreeOf(obj: K8sObject): Record<string, unknown> {
  const { apiVersion: _apiVersion, kind: _kind, ...rest } = obj;
  return rest;
}

/**
 * Read the live property tree for each declared entity, pruning by
 * `metadata.managedFields` (see the module doc). Reuses the same connector,
 * discovery/caching client and tri-state failure classification as the thin
 * read (`./describe-resources.ts`) — the binding check (chant #1100/#1155)
 * still refuses before any resource is touched, and a connect failure still
 * becomes NOT-OBSERVED for every declared entity rather than an empty result.
 */
export async function observeResourcesDeepK8s(
  options: K8sDeepObserveOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<DeepObservationResult> {
  const { managedFieldsOf, isChantFieldManager } = await import("@intentius/chant-k8s-client");

  const declared = [...options.entities].map(([entityName, entity]) => ({
    entityName,
    entityType: entity.entityType,
    props: entity.props,
  }));

  let client;
  try {
    ({ client } = await connect({ environment: options.environment, cwd: options.cwd }));
  } catch (err) {
    if (isMissingClientPackage(err)) {
      return deepObservation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          "read-failed",
          MISSING_CLIENT_DETAIL,
          options.entities,
        ),
      );
    }
    if (isWholeLexiconFailure(err)) {
      const outcome = classifyApiFailure(err);
      return deepObservation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          outcome.kind === "unobserved" ? outcome.reason : "read-failed",
          outcome.kind === "unobserved" ? outcome.detail : undefined,
          options.entities,
        ),
      );
    }
    // A cluster-binding mismatch (chant #1100) — refuse loudly, same as the
    // thin path; core turns the throw into NOT-OBSERVED for every entity.
    throw err;
  }

  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  await client.concurrently(declared, async ({ entityName, entityType, props }) => {
    const operation = operationFor(entityType);
    if (!operation) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no generated operation surface for ${entityType} — run \`chant generate\` in the k8s lexicon, or declare the CRD as a codegen source`,
      };
      return;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      return;
    }

    try {
      const obj = await client.read({
        apiVersion: operation.apiVersion,
        kind: operation.kind,
        name,
        ...(metadata?.namespace ? { namespace: metadata.namespace } : {}),
      });

      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live object carries no chant ownership marker and --owned was requested",
        };
        return;
      }

      const liveRoot = propertiesTreeOf(obj);
      const sets = buildOwnershipSets(managedFieldsOf(obj), liveRoot, props, isChantFieldManager);

      resources[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        properties: normalizeDeepProperties(liveRoot, {
          entityType,
          side: "live",
          hooks: perResourceHooks(sets),
        }),
        // Who owns each surviving path (#1189). The prune above already
        // dropped confidently-foreign undeclared noise, so what reaches the
        // diff is chant's own fields and contested ones — and for a contested
        // field, naming the manager is the whole question: an operator needs to
        // tell `hpa-controller` doing its job from somebody running
        // `kubectl edit`.
        ...(sets.owners.size > 0 ? { fieldOwners: Object.fromEntries(sets.owners) } : {}),
      };
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
      // `absent` records nothing — the thin read already reports the
      // non-existence; restating it here would turn one finding into two.
    }
  });

  return deepObservation(resources, unobserved);
}
