/**
 * Kubernetes-object-shape utilities shared by every lexicon whose live model
 * is a Kubernetes API object — the k8s lexicon itself (chant #1076) and GCP's
 * Config Connector custom resources (chant #1087).
 *
 * A Config Connector custom resource *is* a Kubernetes object: it carries the
 * same envelope (`status`, `metadata.{uid,resourceVersion,generation,
 * creationTimestamp,managedFields,selfLink}`), the same SSA `fieldsV1`
 * encoding for `metadata.managedFields`, and some CNRM kinds even embed
 * genuinely k8s-shaped substructures (Cloud Run's `RunService` wraps a
 * Knative pod spec with `containers`/`env`/`ports`, keyed the same way a
 * Deployment's are). None of that is specific to chant's k8s *lexicon* — it
 * is a fact about the Kubernetes API that any reader of a Kubernetes-shaped
 * object needs, regardless of which lexicon is doing the reading.
 *
 * This module lives in core rather than in the k8s lexicon for the same
 * reason `./kubectl-context.ts`'s `resolveClusterTarget` does (chant #1100):
 * GCP's observation needs it too, without taking a dependency on the k8s
 * lexicon package. Nothing here is keyed by chant's own k8s entityType
 * catalog (`K8s::Apps::Deployment`, …) or by any lexicon's service-default
 * table — that stays lexicon-specific, layered on top of what's here
 * (`lexicons/k8s/src/deep-observe-hooks.ts`'s `K8S_SERVICE_DEFAULTS`,
 * `lexicons/gcp/src/deep-observe.ts`'s CNRM-specific annotation noise).
 */

import type { DeepArrayElement, DeepNode } from "./deep-observation";

// ── The generic Kubernetes object envelope ──────────────────────────────────

/**
 * Paths every Kubernetes API object carries regardless of kind, matched on
 * the exact index-erased pattern (there is exactly one `status`, one
 * `metadata.managedFields`, per object — no per-type variation the way AWS's
 * `Arn`/`RoleId` repeat at every nesting depth).
 *
 * - `status` — the whole subtree is server-computed; no declarative source
 *   (chant's k8s manifests, chant's Config Connector CRs) ever authors it.
 * - `metadata.uid`/`resourceVersion`/`generation`/`creationTimestamp` — minted
 *   and incremented by the API server, never authored.
 * - `metadata.managedFields` — the bookkeeping the ownership walk below reads
 *   to decide everything else. Left in the tree it would report as permanent
 *   drift (a timestamp changes on every write) and would recurse into the
 *   encoded `fieldsV1` structure as if it were ordinary properties.
 * - `metadata.selfLink` — deprecated API-server bookkeeping some clusters
 *   still echo; never a declared field.
 */
export const K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS: ReadonlySet<string> = new Set([
  "status",
  "metadata.uid",
  "metadata.resourceVersion",
  "metadata.generation",
  "metadata.creationTimestamp",
  "metadata.managedFields",
  "metadata.selfLink",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** The final segment of an index-erased pattern (`spec.template.spec.containers[].env[].name` → `name`'s *container*, i.e. `env`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

/**
 * Kubernetes' own well-known list-map-key conventions for the substructures
 * that recur across kinds and across lexicons: containers/initContainers/
 * ephemeralContainers and `env`/`volumes` keyed by `name` — the same field
 * Kubernetes' strategic-merge-patch and SSA's `list-map-keys` key on for
 * these lists — and container ports keyed by `containerPort`+`protocol`,
 * Service ports keyed by `port`+`protocol` (Kubernetes' own SSA
 * `list-map-keys` for each). Both port shapes are handled under one `ports`
 * branch by checking which field is present.
 *
 * Entity-type-agnostic on purpose: whether an array named `containers`
 * belongs to a `K8s::Apps::Deployment` or to a GCP `RunService`'s embedded
 * pod spec, the identity Kubernetes assigns each element is the same.
 */
export function k8sListMapOrderKey(element: DeepArrayElement): string | undefined {
  const name = lastSegment(element.pattern);
  const el = element.element;

  if (name === "containers" || name === "initContainers" || name === "ephemeralContainers") {
    return isRecord(el) && typeof el.name === "string" ? el.name : canonicalJson(el);
  }
  if (name === "env" || name === "volumes") {
    return isRecord(el) && typeof el.name === "string" ? el.name : canonicalJson(el);
  }
  if (name === "ports") {
    if (isRecord(el)) {
      const protocol = typeof el.protocol === "string" ? el.protocol : "TCP";
      // Zero-padded so the sort key orders numerically, not lexicographically
      // ("443" would otherwise sort before "80") — cosmetic, since either
      // order canonicalizes the two sides identically, but a stable,
      // human-sensible order is free to have here.
      if (typeof el.containerPort === "number") return `${String(el.containerPort).padStart(5, "0")}/${protocol}`;
      if (typeof el.port === "number") return `${String(el.port).padStart(5, "0")}/${protocol}`;
    }
    return canonicalJson(el);
  }

  return undefined;
}

// ── managedFields ownership ─────────────────────────────────────────────────

/**
 * The structural shape of one `metadata.managedFields` entry this module
 * needs. Matches `@intentius/chant-k8s-client`'s `ManagedFieldsEntry`
 * (chant #1075) field-for-field, but is declared independently here rather
 * than imported from that package: core must stay reachable from any
 * lexicon's build path, and the k8s client package is deliberately *not*
 * reachable from one (chant #1074's structural boundary,
 * `examples/k8s-client-boundary.test.ts`). A caller that already has a real
 * `ManagedFieldsEntry[]` (the k8s lexicon) passes it straight through —
 * TypeScript's structural typing accepts it with no cast.
 */
export interface ManagedFieldsEntryLike {
  manager?: string;
  operation?: string;
  subresource?: string;
  fieldsV1?: Record<string, unknown>;
}

/** One live object's managed-fields ownership, resolved to chant dot-paths. */
export interface OwnershipSets {
  /** Paths any chant field manager owns on this object. */
  chantOwned: ReadonlySet<string>;
  /** Paths owned by a manager that is not chant. */
  foreignOwned: ReadonlySet<string>;
  /** The subset of `foreignOwned` where the declared manifest also sets the path — a contested field. */
  foreignContested: ReadonlySet<string>;
  /**
   * Path → the name of the manager that owns it (#1189).
   *
   * The three sets above answer *which category* owns a path. A reader needs
   * the other question — "owned by `kubectl-client-side-apply`" and "owned by
   * `hpa-controller`" are the same category and mean very different things to
   * an operator. Since chant #1191 no category is pruned from the diff, so
   * this map is what tells the two apart in the report. Last writer wins
   * where several managers touch one path, matching what the API server
   * itself reports.
   */
  owners: ReadonlyMap<string, string>;
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
 * `@intentius/chant-k8s-client`'s `managed-fields.ts`'s `renderSegment`
 * renders — and an unrecognized prefix is skipped, consistent with that
 * module's own behavior, rather than guessed at.
 */
function walkOwnership(
  fieldsNode: unknown,
  liveNode: unknown,
  declaredNode: unknown,
  path: string,
  owned: Set<string>,
  contested: Set<string>,
  /** Records path → manager as it walks (#1189); omitted by callers that only need the sets. */
  owners?: Map<string, string>,
  manager?: string,
): void {
  if (fieldsNode === null || typeof fieldsNode !== "object" || Array.isArray(fieldsNode)) return;

  for (const [key, child] of Object.entries(fieldsNode as Record<string, unknown>)) {
    if (key === ".") {
      if (path !== "") {
        owned.add(path);
        if (declaredNode !== undefined) contested.add(path);
        if (owners && manager) owners.set(path, manager);
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
      if (owners && manager) owners.set(childPath, manager);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested, owners, manager);
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
      if (owners && manager) owners.set(childPath, manager);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested, owners, manager);
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
      if (owners && manager) owners.set(childPath, manager);
      walkOwnership(child, childLive, childDeclared, childPath, owned, contested, owners, manager);
      continue;
    }
    // An unrecognized prefix (a future fieldsV1 encoding) — skip.
  }
}

/**
 * Build the three ownership sets for one live object. `entries` is
 * `metadata.managedFields`, already decoded (`@intentius/chant-k8s-client`'s
 * `managedFieldsOf` for the k8s lexicon; a plain `JSON.parse` of `kubectl get
 * -o json` for gcp); `isChantManager` classifies each entry's manager name
 * — matched on the `chant`/`chant:<stack>` family per chant #1075, but the
 * matcher itself is supplied by the caller rather than fixed here, because
 * what counts as "chant" is not the same fact on every lexicon's apply path
 * (see gcp's `deep-observe.ts` module doc for why that matters there).
 *
 * Subresource entries (`status`, `scale`) are excluded: a controller writing
 * a Deployment's `status` is not competing for the spec chant declared, the
 * same reasoning `@intentius/chant-k8s-client`'s `fieldsOwnedBy` default
 * already encodes.
 */
export function buildOwnershipSets(
  entries: readonly ManagedFieldsEntryLike[],
  liveRoot: Record<string, unknown>,
  declaredRoot: Record<string, unknown>,
  isChantManager: (manager: string | undefined) => boolean,
): OwnershipSets {
  const chantOwned = new Set<string>();
  const foreignOwned = new Set<string>();
  const foreignContested = new Set<string>();
  const owners = new Map<string, string>();

  for (const entry of entries) {
    if (typeof entry.manager !== "string" || entry.manager.length === 0) continue;
    if (entry.subresource !== undefined) continue;

    if (isChantManager(entry.manager)) {
      // Chant-owned paths are always diffable, regardless of who else is
      // involved — "contested" only matters for a *foreign* owner.
      walkOwnership(entry.fieldsV1, liveRoot, declaredRoot, "", chantOwned, new Set(), owners, entry.manager);
    } else {
      walkOwnership(entry.fieldsV1, liveRoot, declaredRoot, "", foreignOwned, foreignContested, owners, entry.manager);
    }
  }

  return { chantOwned, foreignOwned, foreignContested, owners };
}

/**
 * Well-known metadata the control plane writes on an object regardless of
 * who applied it — matched on the exact index-erased pattern, like
 * {@link K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS}, but gated by the caller on
 * `side === "live" && counterpart === "absent"` so a manifest that *does*
 * declare one of these (a hand-pinned `change-cause`, say) is still compared.
 *
 * This list is the noise valve that replaced the managed-fields prune
 * (chant #1191). Until then a foreign-owned, undeclared path was dropped
 * before the diff ever saw it, which silenced `kubectl label deploy web
 * team=platform` — the exact console-edit class the `undeclared` drift kind
 * exists for. Now a foreign-owned path nobody declared is reported as
 * `undeclared` (with its owner named, #1189) unless the accepted baseline
 * already carries it — and what remains to subtract statically is only the
 * handful of annotations and labels Kubernetes' own controllers stamp on
 * every object of a kind. Widening this set is additive; each entry must be
 * something *no* human writes out of band.
 *
 * - `kubectl.kubernetes.io/last-applied-configuration` — client-side apply's
 *   bookkeeping, a JSON copy of whatever was last applied.
 * - `deployment.kubernetes.io/revision` (+ `revision-history`,
 *   `desired-replicas`, `max-replicas`) — the Deployment controller's
 *   rollout counters, written to Deployments and their ReplicaSets.
 * - `pod-template-hash` / `controller-revision-hash` /
 *   `statefulset.kubernetes.io/pod-name` — the selector labels the
 *   ReplicaSet, DaemonSet and StatefulSet controllers add to what they own.
 */
export const K8S_SYSTEM_METADATA_PRUNE_PATTERNS: ReadonlySet<string> = new Set([
  "metadata.annotations.kubectl.kubernetes.io/last-applied-configuration",
  "metadata.annotations.deployment.kubernetes.io/revision",
  "metadata.annotations.deployment.kubernetes.io/revision-history",
  "metadata.annotations.deployment.kubernetes.io/desired-replicas",
  "metadata.annotations.deployment.kubernetes.io/max-replicas",
  "metadata.labels.pod-template-hash",
  "metadata.labels.controller-revision-hash",
  "metadata.labels.statefulset.kubernetes.io/pod-name",
  "spec.template.metadata.labels.pod-template-hash",
  "spec.template.metadata.labels.controller-revision-hash",
]);
