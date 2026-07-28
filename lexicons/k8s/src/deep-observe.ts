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
 */

import type { K8sObject, ManagedFieldsEntry } from "@intentius/chant-k8s-client";
import type {
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
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
export { k8sDeepNormalizationHooks };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findKeyedIndex(array: readonly unknown[], keyFields: Record<string, unknown>): number {
  return array.findIndex(
    (el) => isRecord(el) && Object.entries(keyFields).every(([k, v]) => sameJson(el[k], v)),
  );
}

function findValueIndex(array: readonly unknown[], value: unknown): number {
  return array.findIndex((el) => sameJson(el, value));
}

function joinField(parent: string, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function joinIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/**
 * Walk one manager's `fieldsV1` tree in lockstep with the live object and the
 * declared props, threading the *live* dot-path (chant's own path syntax —
 * no leading dot, real array indices) as it goes. `owned` collects every path
 * this manager's entry reaches on the live tree; `contested` collects the
 * subset where the declared tree also has a value at the equivalent
 * position, resolved by the same key/value match rather than by index.
 *
 * Only `f:`/`i:`/`v:`/`k:`/`.` are understood — the same five forms
 * `managed-fields.ts`'s `renderSegment` renders — and an unrecognized prefix
 * is skipped, consistent with that module's own behavior, rather than
 * guessed at.
 */
function walkOwnership(
  fieldsNode: unknown,
  liveNode: unknown,
  declaredNode: unknown,
  path: string,
  owned: Set<string>,
  contested: Set<string>,
): void {
  if (fieldsNode === null || typeof fieldsNode !== "object" || Array.isArray(fieldsNode)) return;

  for (const [key, child] of Object.entries(fieldsNode as Record<string, unknown>)) {
    if (key === ".") {
      if (path !== "") {
        owned.add(path);
        if (declaredNode !== undefined) contested.add(path);
      }
      continue;
    }

    if (key.startsWith("f:")) {
      const name = key.slice(2);
      if (!isRecord(liveNode) || !(name in liveNode)) continue;
      const childLive = liveNode[name];
      const childDeclared = isRecord(declaredNode) ? declaredNode[name] : undefined;
      const childPath = joinField(path, name);
      owned.add(childPath);
      if (childDeclared !== undefined) contested.add(childPath);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested);
      continue;
    }

    if (key.startsWith("i:")) {
      const idx = Number(key.slice(2));
      if (!Array.isArray(liveNode) || !Number.isInteger(idx) || idx < 0 || idx >= liveNode.length) continue;
      const childLive: unknown = liveNode[idx];
      const childDeclared = Array.isArray(declaredNode) ? declaredNode[idx] : undefined;
      const childPath = joinIndex(path, idx);
      owned.add(childPath);
      if (childDeclared !== undefined) contested.add(childPath);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested);
      continue;
    }

    if (key.startsWith("v:") || key.startsWith("k:")) {
      if (!Array.isArray(liveNode)) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(key.slice(2));
      } catch {
        continue; // not decodable JSON — skip rather than mangle, like renderSegment.
      }

      const liveIdx =
        key.startsWith("v:")
          ? findValueIndex(liveNode, decoded)
          : isRecord(decoded)
            ? findKeyedIndex(liveNode, decoded)
            : -1;
      if (liveIdx === -1) continue;

      let childDeclared: unknown;
      if (Array.isArray(declaredNode)) {
        const declaredIdx = key.startsWith("v:")
          ? findValueIndex(declaredNode, decoded)
          : isRecord(decoded)
            ? findKeyedIndex(declaredNode, decoded)
            : -1;
        childDeclared = declaredIdx === -1 ? undefined : declaredNode[declaredIdx];
      }

      const childLive: unknown = liveNode[liveIdx];
      const childPath = joinIndex(path, liveIdx);
      owned.add(childPath);
      if (childDeclared !== undefined) contested.add(childPath);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested);
      continue;
    }
    // An unrecognized prefix (a future fieldsV1 encoding) — skip.
  }
}

/** One live object's managed-fields ownership, resolved to chant dot-paths. */
export interface OwnershipSets {
  /** Paths any chant field manager owns on this object. */
  chantOwned: ReadonlySet<string>;
  /** Paths owned by a manager that is not chant. */
  foreignOwned: ReadonlySet<string>;
  /** The subset of `foreignOwned` where the declared manifest also sets the path — drift-relevant despite foreign ownership. */
  foreignContested: ReadonlySet<string>;
}

/**
 * Build the three ownership sets for one live object. `entries` is
 * `metadata.managedFields`, already decoded by
 * `@intentius/chant-k8s-client`'s `managedFieldsOf`; `isChantManager`
 * classifies each entry's manager name (`isChantFieldManager`, matched on the
 * `chant`/`chant:<stack>` family per chant #1075).
 *
 * Subresource entries (`status`, `scale`) are excluded: a controller writing
 * a Deployment's `status` is not competing for the spec chant declared, the
 * same reasoning `fieldsOwnedBy`'s default already encodes.
 */
export function buildOwnershipSets(
  entries: readonly ManagedFieldsEntry[],
  liveRoot: Record<string, unknown>,
  declaredRoot: Record<string, unknown>,
  isChantManager: (manager: string | undefined) => boolean,
): OwnershipSets {
  const chantOwned = new Set<string>();
  const foreignOwned = new Set<string>();
  const foreignContested = new Set<string>();

  for (const entry of entries) {
    if (typeof entry.manager !== "string" || entry.manager.length === 0) continue;
    if (entry.subresource !== undefined) continue;

    if (isChantManager(entry.manager)) {
      // Chant-owned paths are always diffable, regardless of who else is
      // involved — "contested" only matters for a *foreign* owner.
      walkOwnership(entry.fieldsV1, liveRoot, declaredRoot, "", chantOwned, new Set());
    } else {
      walkOwnership(entry.fieldsV1, liveRoot, declaredRoot, "", foreignOwned, foreignContested);
    }
  }

  return { chantOwned, foreignOwned, foreignContested };
}

/**
 * The managed-fields prune, composed with the static rules, for one
 * resource's normalization call. See the module doc for the three-question
 * rule this encodes.
 */
function perResourceHooks(sets: OwnershipSets): DeepNormalizationHooks {
  return {
    prune(node) {
      if (k8sDeepNormalizationHooks.prune?.(node)) return true;
      if (node.side !== "live") return false;
      if (sets.chantOwned.has(node.path)) return false;
      if (!sets.foreignOwned.has(node.path)) return false;
      if (sets.foreignContested.has(node.path)) return false;
      return true;
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
