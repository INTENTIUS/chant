/**
 * Resource Graph's type names as azure lexicon kinds (#4521).
 *
 * behold#1029 lists Azure through Resource Graph, which lowercases every
 * type and joins a child to its parent with `/`
 * (`microsoft.network/virtualnetworks/subnets`). The lexicon's kinds come
 * from the ARM schema ids, mixed case with `_` between a child and its parent
 * (`Microsoft.Network/virtualNetworks_subnets`). So the mapping is a lookup:
 * every kind, through {@link armType} and lowercased, is the listed type it
 * answers to. ARM type names are case-insensitive, so no two kinds share one.
 *
 * A Resource Graph row has ARM's resource shape (`properties` beside
 * `location`, `sku`, `identity`), and the deep reader flattens that shape
 * before the hooks run (./deep-observe.ts `buildLiveProperties`), so an
 * indexed row is flattened the same way.
 */
import type { ListedTypeMapping } from "@intentius/chant/lifecycle/type-listing";
import { armType } from "./arm-type";
import { buildLiveProperties, type ArmResourceShowResponse } from "./deep-observe";
import { loadApiVersions } from "./serializer";

/** `Microsoft.Network/virtualNetworks_subnets` as Resource Graph spells it: `microsoft.network/virtualnetworks/subnets`. */
export function azureListedTypeForKind(kind: string): string {
  return armType(kind).toLowerCase();
}

/** Listed type to kind, over a set of kinds. */
export function azureListedTypeIndex(kinds: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const kind of kinds) out.set(azureListedTypeForKind(kind), kind);
  return out;
}

let cachedIndex: Map<string, string> | null | undefined;

/** Built from the generated registry, or null in a checkout that has not generated. */
function generatedIndex(): Map<string, string> | null {
  if (cachedIndex !== undefined) return cachedIndex;
  try {
    cachedIndex = azureListedTypeIndex(loadApiVersions().keys());
  } catch {
    cachedIndex = null;
  }
  return cachedIndex;
}

/**
 * The azure kind for a Resource Graph type, or undefined. Without a registry
 * nothing maps: Resource Graph's lowercase spelling cannot be turned back
 * into the kind's casing by rule.
 */
export function azureKindForListedType(listedType: string, index: Map<string, string> | null = generatedIndex()): string | undefined {
  return index?.get(listedType.toLowerCase());
}

/** A Resource Graph row in the tree the deep reader compares. */
export function azureObservedTree(properties: Record<string, unknown>): Record<string, unknown> {
  return buildLiveProperties(properties as ArmResourceShowResponse);
}

export const azureListedTypes: ListedTypeMapping = {
  substrate: "azure",
  kindFor: (listedType) => azureKindForListedType(listedType),
  observedTree: (properties) => azureObservedTree(properties),
};
