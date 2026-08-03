/**
 * Associative-list key table, derived from the spec rather than hardcoded
 * (chant #1441).
 *
 * The Kubernetes OpenAPI spec states, per property, how the API server merges
 * a list: `x-kubernetes-list-type: map` plus `x-kubernetes-list-map-keys`
 * naming the fields that jointly identify one element. chant's drift engine
 * needs exactly that to compare `containers` by name rather than by index.
 * Before this, `k8sListMapOrderKey` (core's `managed-fields.ts`) hardcoded six
 * properties; the spec annotates 32.
 *
 * ## Why the table is keyed by property name
 *
 * The consumer is `DeepNormalizationHooks.orderKey`, which receives an
 * index-erased `pattern` (`spec.template.spec.containers`) and keys off its
 * LAST segment. A by-name table matches that lookup exactly and needs no
 * resolution of the definition graph at generation time.
 *
 * The cost is that two definitions declaring the same property name with
 * different keys collapse into one entry. That is real but small, and it is
 * represented rather than lost: each name maps to a LIST of candidate key
 * sets, and the consumer picks the first whose fields are all present on the
 * element. In v1.36.2 exactly one property needs it — `ports`, keyed
 * `(containerPort, protocol)` on a container and `(port, protocol)` on a
 * Service — which is the same dual shape the hardcoded implementation already
 * special-cased by hand.
 *
 * ## Two sources
 *
 * The whole spec is read directly, because chant emits types for 257 of
 * roughly a thousand definitions and the merge semantics of a definition are
 * worth having whether or not it becomes a type. Reading only the parsed
 * results finds 18 of the 32 properties and misses `ServicePort.port`.
 *
 * Parsed results are read too, because CRDs arrive that way — an operator CRD
 * that declares these extensions contributes its keys for free.
 */

import type { K8sParseResult, ParsedProperty } from "../spec/parse";

/** Property name → candidate key-field sets, most-specific first. */
export type ListMapKeyTable = Record<string, string[][]>;

function everyProperty(results: K8sParseResult[]): ParsedProperty[] {
  const out: ParsedProperty[] = [];
  for (const r of results) {
    out.push(...r.resource.properties);
    for (const pt of r.propertyTypes) out.push(...pt.properties);
  }
  return out;
}

/** The `(name, keys)` pairs carried on parsed properties — core types and every CRD. */
export function parsedListMapKeyPairs(results: K8sParseResult[]): Array<[string, string[]]> {
  const pairs: Array<[string, string[]]> = [];
  for (const p of everyProperty(results)) {
    if (p.listType === "map" && p.listMapKeys?.length) pairs.push([p.name, p.listMapKeys]);
  }
  return pairs;
}

/**
 * Fold `(name, keys)` pairs into a by-name table.
 *
 * Candidate sets are deduplicated by content and ordered longest-first, so a
 * more specific key set is tried before a shorter one whose fields a longer
 * element would also satisfy.
 */
export function buildListMapKeyTable(...sources: Array<Array<[string, string[]]>>): ListMapKeyTable {
  const byName = new Map<string, Map<string, string[]>>();

  for (const pairs of sources) {
    for (const [name, rawKeys] of pairs) {
      const keys = [...rawKeys].sort();
      const seen = byName.get(name) ?? new Map<string, string[]>();
      seen.set(keys.join(" "), keys);
      byName.set(name, seen);
    }
  }

  const table: ListMapKeyTable = {};
  for (const name of [...byName.keys()].sort()) {
    const variants = byName.get(name);
    if (!variants) continue;
    const sets = [...variants.values()];
    sets.sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()));
    table[name] = sets;
  }
  return table;
}

/** Serialize the `list-map-keys.json` generated artifact. */
export function generateListMapKeysJSON(
  specPairs: Array<[string, string[]]>,
  results: K8sParseResult[],
): string {
  const table = buildListMapKeyTable(specPairs, parsedListMapKeyPairs(results));
  return `${JSON.stringify(table, null, 2)}\n`;
}
