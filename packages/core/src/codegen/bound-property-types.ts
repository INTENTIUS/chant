/**
 * Bound the set of generated property-type interfaces a lexicon emits.
 *
 * Cloud provider schemas (ARM, CloudFormation, …) embed a named definition for
 * every nested object. Fully expanding all of them per-resource produces huge
 * `.d.ts` declarations (azure was ~273MB — see #438). This helper keeps only
 * the property types reachable from a resource's top-level properties within a
 * depth bound, plus a curated force-keep set; references that fall outside the
 * kept set are rewritten to `Record<string, unknown>`. Enum references are
 * preserved. The input property refs are mutated in place. (#438, #440)
 */

/** A reference carrying a TypeScript type string, mutated in place when loosened. */
export interface BoundablePropertyRef {
  tsType: string;
}

/** A generated property type (named interface) and its properties. */
export interface BoundablePropertyType {
  name: string;
  specType: string;
  properties: BoundablePropertyRef[];
}

export interface BoundPropertyTypeOptions {
  /** Maximum nesting depth of emitted property-type interfaces. */
  maxDepth: number;
  /**
   * Definition-name substrings to always keep regardless of reachability/depth
   * (e.g. common nested shapes worth typing for authoring ergonomics). Matched
   * by substring against each property type's `specType`.
   */
  curatedDefs?: Iterable<string>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract `${shortName}_Ident` type-reference tokens from a tsType string. */
function referencedTypeNames(tsType: string, shortName: string): string[] {
  const re = new RegExp("\\b" + escapeRegExp(shortName) + "_[A-Za-z0-9_]+", "g");
  return tsType.match(re) ?? [];
}

/**
 * Filter `propertyTypes` to the bounded set and loosen out-of-set references.
 * Mutates the `tsType` of `resourceProps` and retained property types; returns
 * the retained property types.
 */
export function boundPropertyTypes<PT extends BoundablePropertyType>(
  shortName: string,
  resourceProps: BoundablePropertyRef[],
  propertyTypes: PT[],
  enumNames: Set<string>,
  options: BoundPropertyTypeOptions,
): PT[] {
  const { maxDepth } = options;
  const curated = options.curatedDefs ? [...options.curatedDefs] : [];
  const byName = new Map(propertyTypes.map((pt) => [pt.name, pt] as const));
  const reached = new Set<string>();
  const queue: Array<{ name: string; depth: number }> = [];

  const seed = (tsType: string, depth: number) => {
    for (const n of referencedTypeNames(tsType, shortName)) {
      if (byName.has(n) && !reached.has(n)) {
        reached.add(n);
        queue.push({ name: n, depth });
      }
    }
  };

  for (const p of resourceProps) seed(p.tsType, 1);
  // Force-keep curated property types (depth-1 seeds), matched by substring so
  // schema variant names (e.g. "SecurityRulePropertiesFormat") are retained.
  if (curated.length > 0) {
    for (const pt of propertyTypes) {
      if (!reached.has(pt.name) && curated.some((c) => pt.specType.includes(c))) {
        reached.add(pt.name);
        queue.push({ name: pt.name, depth: 1 });
      }
    }
  }
  while (queue.length) {
    const { name, depth } = queue.shift()!;
    if (depth >= maxDepth) continue; // do not expand children beyond the cap
    const pt = byName.get(name);
    if (!pt) continue;
    for (const p of pt.properties) seed(p.tsType, depth + 1);
  }

  // Rewrite references to property types we are not emitting (keep enums).
  const loosen = (tsType: string): string => {
    let out = tsType;
    for (const n of referencedTypeNames(tsType, shortName)) {
      if (reached.has(n) || enumNames.has(n) || !byName.has(n)) continue;
      out = out.replace(new RegExp("\\b" + escapeRegExp(n) + "\\b", "g"), "Record<string, unknown>");
    }
    return out;
  };

  for (const p of resourceProps) p.tsType = loosen(p.tsType);
  const retained: PT[] = [];
  for (const pt of propertyTypes) {
    if (!reached.has(pt.name)) continue;
    for (const p of pt.properties) p.tsType = loosen(p.tsType);
    retained.push(pt);
  }
  return retained;
}
