/**
 * Pure Terraform dependency-graph builder for the carve-out advisor (#214 T1).
 *
 * Input is the JSON tree `@cdktf/hcl2json` produces (`Hcl2JsonTree`) plus the
 * traversal accessors its expression AST found per interpolated string
 * (`ExpressionRefs`, resolved in `parse.ts` — #998). Tokenizing `${...}`
 * expression bodies is the AST's job — a quoted address inside an expression
 * (`var.m["aws_s3_bucket.assets.arn"]`) or an escaped `$${...}` literal is not
 * a reference, which the regex scan this replaced could not tell. This module
 * only classifies the accessors the AST produced: no wasm, no filesystem, so
 * graph building stays unit-testable on hand-written fixtures.
 */

import { IDENTITY_ATTR } from "./tier-map";
import type { Hcl2JsonTree, TfEdge, TfGraph, TfNode } from "./types";

/**
 * Traversal accessors per interpolated string, as the hcl2json expression AST
 * reports them (`getReferencesInExpression`): `"${aws_s3_bucket.assets.arn}"`
 * maps to `["aws_s3_bucket.assets.arn"]`. Keys are the raw hcl2json string
 * values; a missing key means the expression yielded no references.
 */
export type ExpressionRefs = ReadonlyMap<string, readonly string[]>;

/** Non-resource reference heads that must never be read as a resource type. */
const NON_RESOURCE_HEADS = new Set(["var", "local", "each", "count", "self", "path", "terraform"]);

interface RawRef {
  address: string;
  attr?: string;
  /** The referring block's top-level attribute the reference sits in (#998). */
  via?: string;
}

/**
 * Split a traversal accessor into segments. Dots inside a quoted map key
 * (`var.m."a.b"` — how the AST renders `var.m["a.b"]`) do not split.
 */
function accessorSegments(accessor: string): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < accessor.length) {
    if (accessor[i] === '"') {
      const close = accessor.indexOf('"', i + 1);
      const end = close === -1 ? accessor.length : close + 1;
      segments.push(accessor.slice(i, end));
      i = end;
    } else {
      let j = i;
      while (j < accessor.length && accessor[j] !== ".") j++;
      segments.push(accessor.slice(i, j));
      i = j;
    }
    if (accessor[i] === ".") i++;
  }
  return segments;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Classify one AST traversal accessor into a resource/module/data reference.
 * `var.*`/`local.*`/`each.*`-headed accessors are not references; quoted map
 * keys and numeric indexes never become the attribute.
 */
export function refFromAccessor(accessor: string): RawRef | null {
  const parts = accessorSegments(accessor);
  const isName = (s: string | undefined): s is string => s !== undefined && NAME.test(s);
  const attrAfter = (idx: number): string | undefined => parts.slice(idx).find((p) => isName(p));

  if (parts[0] === "module") {
    return isName(parts[1]) ? { address: `module.${parts[1]}`, attr: attrAfter(2) } : null;
  }
  if (parts[0] === "data") {
    return isName(parts[1]) && isName(parts[2])
      ? { address: `data.${parts[1]}.${parts[2]}`, attr: attrAfter(3) }
      : null;
  }
  if (NON_RESOURCE_HEADS.has(parts[0]) || !isName(parts[0]) || !isName(parts[1])) return null;
  return { address: `${parts[0]}.${parts[1]}`, attr: attrAfter(2) };
}

/**
 * Every string value carrying an interpolation across the tree's resource and
 * module blocks — exactly the expressions `parse.ts` must resolve through the
 * AST before `buildGraph` can classify them.
 */
export function collectExpressions(tree: Hcl2JsonTree): string[] {
  const exprs = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes("${")) exprs.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) visit(inner);
    }
  };
  for (const named of Object.values(tree.resource ?? {})) for (const blocks of Object.values(named)) visit(blocks);
  for (const blocks of Object.values(tree.module ?? {})) visit(blocks);
  return [...exprs].sort();
}

/** Collect every reference reachable in a block's value tree, via the AST-resolved accessors. */
function refsInValue(value: unknown, exprRefs: ExpressionRefs): RawRef[] {
  const refs: RawRef[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (!v.includes("${")) return;
      for (const accessor of exprRefs.get(v) ?? []) {
        const ref = refFromAccessor(accessor);
        if (ref) refs.push(ref);
      }
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) visit(inner);
    }
  };
  visit(value);
  return refs;
}

/**
 * References in a whole block, each tagged with the top-level attribute it
 * came in through — `via` is what a deferred outbound input gets named after
 * when emit turns it into a build parameter (#998).
 */
function refsInBlock(block: unknown, exprRefs: ExpressionRefs): RawRef[] {
  if (!block || typeof block !== "object" || Array.isArray(block)) return refsInValue(block, exprRefs);
  const refs: RawRef[] = [];
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    for (const ref of refsInValue(value, exprRefs)) refs.push({ ...ref, via: key });
  }
  return refs;
}

/** A block carries `count`/`for_each` → dynamic, single instance until state resolves it. */
function blockHasMeta(block: unknown, key: string): boolean {
  return !!block && typeof block === "object" && key in (block as Record<string, unknown>);
}

/** The resource's physical name, if its identity attribute is a plain literal (not interpolated). */
function literalIdentity(block: unknown, type: string): string | undefined {
  const attr = IDENTITY_ATTR[type];
  if (!attr || !block || typeof block !== "object") return undefined;
  const value = (block as Record<string, unknown>)[attr];
  if (typeof value !== "string" || value.includes("${")) return undefined;
  return value;
}

/**
 * Build the dependency graph from a merged hcl2json tree.
 *
 * `resource` and `module` blocks become nodes. `data` sources are NOT nodes
 * (they are not carvable infrastructure), but a reference *to* a data source
 * marks the referring node dynamic. An edge is recorded only when its target
 * resolves to a known resource/module node — references to `var`/`local`/data
 * are dropped.
 */
export function buildGraph(tree: Hcl2JsonTree, exprRefs: ExpressionRefs): TfGraph {
  const nodes: TfNode[] = [];
  const dataAddresses = new Set<string>();

  // First pass: register data-source addresses so refs to them can be spotted.
  for (const [type, named] of Object.entries(tree.data ?? {})) {
    for (const name of Object.keys(named)) dataAddresses.add(`data.${type}.${name}`);
  }

  // Resource nodes.
  const rawRefsByNode = new Map<string, RawRef[]>();
  for (const [type, named] of Object.entries(tree.resource ?? {})) {
    for (const [name, blocks] of Object.entries(named)) {
      const address = `${type}.${name}`;
      const block = Array.isArray(blocks) ? blocks[0] : blocks;
      const dynamic = blockHasMeta(block, "count") || blockHasMeta(block, "for_each");
      const refs = refsInBlock(block, exprRefs);
      const touchesData = refs.some((r) => dataAddresses.has(r.address));
      rawRefsByNode.set(address, refs);
      nodes.push({
        address,
        kind: "resource",
        type,
        name,
        instances: 1,
        hasDynamic: dynamic || touchesData,
        identity: literalIdentity(block, type),
      });
    }
  }

  // Module nodes.
  for (const [name, blocks] of Object.entries(tree.module ?? {})) {
    const address = `module.${name}`;
    const block = Array.isArray(blocks) ? blocks[0] : blocks;
    const dynamic = blockHasMeta(block, "count") || blockHasMeta(block, "for_each");
    const refs = refsInBlock(block, exprRefs);
    const touchesData = refs.some((r) => dataAddresses.has(r.address));
    rawRefsByNode.set(address, refs);
    nodes.push({
      address,
      kind: "module",
      name,
      instances: 1,
      hasDynamic: dynamic || touchesData,
    });
  }

  // Edges: keep only references that resolve to a known node.
  const known = new Set(nodes.map((n) => n.address));
  const edges: TfEdge[] = [];
  for (const [from, refs] of rawRefsByNode) {
    const byTarget = new Map<string, { attrs: Set<string>; via: Set<string> }>();
    for (const ref of refs) {
      if (ref.address === from || !known.has(ref.address)) continue;
      if (!byTarget.has(ref.address)) byTarget.set(ref.address, { attrs: new Set(), via: new Set() });
      const target = byTarget.get(ref.address)!;
      if (ref.attr) target.attrs.add(ref.attr);
      if (ref.via) target.via.add(ref.via);
    }
    for (const [to, { attrs, via }] of byTarget) {
      edges.push({ from, to, attrs: [...attrs].sort(), via: [...via].sort() });
    }
  }

  // Code-point ordering (not localeCompare) so output is locale-independent and
  // punctuation sorts predictably (`.` < `_`).
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    nodes: nodes.sort((a, b) => cmp(a.address, b.address)),
    edges: edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
  };
}

/** Edges where other nodes depend on `address` (each → a surviving-TF data-source patch). */
export function inboundEdges(graph: TfGraph, address: string): TfEdge[] {
  return graph.edges.filter((e) => e.to === address);
}

/** Edges where `address` depends on other nodes (each → a deferred deploy-time input). */
export function outboundEdges(graph: TfGraph, address: string): TfEdge[] {
  return graph.edges.filter((e) => e.from === address);
}
