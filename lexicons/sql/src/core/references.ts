/**
 * References between schema objects, in every dialect: column lineage, the
 * name a reference is written under in a build's output, and the order
 * objects are created in.
 */

import type { Declarable } from "@intentius/chant";
import type { AttrRef } from "@intentius/chant/attrref";
import { isAttrRefLike } from "@intentius/chant/utils";

/** One output column of a view and the columns it is computed from. */
export interface LineageEdge {
  output: string;
  /** The select-list expression, rendered. */
  expr: string;
  /** The column references inside it. */
  from: AttrRef[];
}

/** What the dependency order needs of an object: the references its DDL makes. */
export interface Referencing {
  readonly dependsOn: readonly unknown[];
}

/**
 * A reference as a build's output writes it: an entity's export name, or
 * `export.column` for a column. Undefined when the target is not exported.
 */
export function referenceName(value: unknown, names: Map<Declarable, string>): string | undefined {
  if (isAttrRefLike(value)) {
    const parent = value.parent.deref() as Declarable | undefined;
    const owner = parent ? names.get(parent) : undefined;
    return owner ? `${owner}.${value.attribute}` : undefined;
  }
  return names.get(value as Declarable);
}

/** Lineage edges with their column references written as `export.column`. */
export function lineageJson(edges: readonly LineageEdge[], names: Map<Declarable, string>): Array<{ output: string; expr: string; from: Array<string | null> }> {
  return edges.map((e) => ({
    output: e.output,
    expr: e.expr,
    from: e.from.map((r) => referenceName(r, names) ?? null),
  }));
}

/**
 * Export names in creation order: an object after everything it references.
 * Ties break by export name, so the order is the same however the files were
 * discovered. A reference cycle is an error naming the cycle.
 */
export function applyOrder(objects: Map<string, Referencing>, names: Map<Declarable, string>): string[] {
  const deps = new Map<string, string[]>();
  for (const [name, obj] of objects) {
    const on = new Set<string>();
    for (const ref of obj.dependsOn) {
      const parent = isAttrRefLike(ref) ? (ref.parent.deref() as Declarable | undefined) : (ref as Declarable);
      const dep = parent ? names.get(parent) : undefined;
      if (dep !== undefined && dep !== name && objects.has(dep)) on.add(dep);
    }
    deps.set(name, [...on].sort());
  }
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (n: string, stack: string[]) => {
    if (done.has(n)) return;
    if (stack.includes(n)) throw new Error(`sql: a reference cycle between schema objects: ${[...stack, n].join(" -> ")}`);
    for (const d of deps.get(n) ?? []) visit(d, [...stack, n]);
    done.add(n);
    order.push(n);
  };
  for (const n of [...objects.keys()].sort()) visit(n, []);
  return order;
}
