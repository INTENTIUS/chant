/**
 * Kubernetes discovery's type names as k8s lexicon kinds (#4521).
 *
 * behold#1029 lists a cluster through API discovery and LIST, and names each
 * object's type by group, version and kind: `apps/v1/Deployment`, or
 * `v1/Pod` for the core group. The lexicon's kinds are
 * `K8s::<Group>::<Kind>`, the group's segment from the one rule every other
 * path uses (./group-namespace.ts, as `gvkToTypeName` applies it). The
 * version is not part of the kind.
 *
 * A listed object is the whole manifest. The deep reader compares it without
 * `apiVersion` and `kind`, so those two are dropped before the hooks run.
 */
import type { ListedTypeMapping } from "@intentius/chant/lifecycle/type-listing";
import { operationTable } from "./api/operation-surface";
import { namespaceSegmentForGroup } from "./group-namespace";

/** `apps/v1/Deployment` or `v1/Pod` as its group, version and kind. */
export function parseListedGvk(listedType: string): { group: string; version: string; kind: string } | undefined {
  const parts = listedType.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) return { group: "", version: parts[0], kind: parts[1] };
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) return { group: parts[0], version: parts[1], kind: parts[2] };
  return undefined;
}

/** `apiVersion` (`apps/v1`, `v1`) and kind as the listed type behold's lister writes. */
export function k8sListedTypeFor(apiVersion: string, kind: string): string {
  return `${apiVersion}/${kind}`;
}

/** The kind the group rule gives, before any check that the lexicon has it. */
export function k8sKindByRule(listedType: string): string | undefined {
  const gvk = parseListedGvk(listedType);
  if (!gvk) return undefined;
  return `K8s::${namespaceSegmentForGroup(gvk.group)}::${gvk.kind}`;
}

let cachedKinds: ReadonlySet<string> | null | undefined;

/** The entity types of the generated operation surface, or null in a checkout that has not generated. */
function generatedKinds(): ReadonlySet<string> | null {
  if (cachedKinds !== undefined) return cachedKinds;
  const table = operationTable();
  cachedKinds = Object.keys(table).length > 0 ? new Set(Object.keys(table)) : null;
  return cachedKinds;
}

/**
 * The k8s kind for a discovery type, or undefined. The rule's answer must be
 * a kind the lexicon generated; with nothing generated the rule's answer
 * stands, as the lexicon's own discovery sweep does.
 */
export function k8sKindForListedType(listedType: string, kinds: ReadonlySet<string> | null = generatedKinds()): string | undefined {
  const kind = k8sKindByRule(listedType);
  if (kind === undefined) return undefined;
  if (kinds && !kinds.has(kind)) return undefined;
  return kind;
}

/** A listed object in the tree the deep reader compares. */
export function k8sObservedTree(properties: Record<string, unknown>): Record<string, unknown> {
  const { apiVersion: _apiVersion, kind: _kind, ...rest } = properties;
  return rest;
}

export const k8sListedTypes: ListedTypeMapping = {
  substrate: "kubernetes",
  kindFor: (listedType) => k8sKindForListedType(listedType),
  observedTree: (properties) => k8sObservedTree(properties),
};
