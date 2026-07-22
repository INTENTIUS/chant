/**
 * Pure Terraform dependency-graph builder for the carve-out advisor (#214 T1).
 *
 * Input is the JSON tree `@cdktf/hcl2json` produces (`Hcl2JsonTree`). No wasm,
 * no filesystem — so the graph and its edge classification are unit-testable
 * on hand-written fixtures. `parse.ts` is the thin glue that loads the wasm
 * parser and feeds this.
 */

import { IDENTITY_ATTR } from "./tier-map";
import type { Hcl2JsonTree, TfEdge, TfGraph, TfNode } from "./types";

/**
 * hcl2json leaves interpolations as `${...}` strings. Match each expression
 * body; reference heads are extracted from it in `refsFromExpression`.
 */
const INTERPOLATION = /\$\{([^}]+)\}/g;

/** `module.<name>` reference head. */
const MODULE_REF = /\bmodule\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?/g;

/** `data.<type>.<name>` reference head. */
const DATA_REF = /\bdata\.([a-z][a-z0-9_]*)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?/g;

/**
 * `<type>.<name>` resource reference head. Deliberately broad — it also
 * matches `var.x`, `local.y`, `each.value`, function-ish tokens. Only heads
 * whose address is a known node survive into an edge (see `buildGraph`).
 */
const RESOURCE_REF = /\b([a-z][a-z0-9_]*)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?/g;

/** Non-resource reference prefixes that must never be read as a resource type. */
const NON_RESOURCE_HEADS = new Set(["var", "local", "module", "data", "each", "count", "self", "path", "terraform"]);

interface RawRef {
  address: string;
  attr?: string;
}

/** Pull every resource/module/data reference out of one interpolation body. */
function refsFromExpression(expr: string): RawRef[] {
  const refs: RawRef[] = [];

  for (const m of expr.matchAll(MODULE_REF)) {
    refs.push({ address: `module.${m[1]}`, attr: m[2] });
  }
  for (const m of expr.matchAll(DATA_REF)) {
    refs.push({ address: `data.${m[1]}.${m[2]}`, attr: m[3] });
  }
  for (const m of expr.matchAll(RESOURCE_REF)) {
    if (NON_RESOURCE_HEADS.has(m[1])) continue;
    refs.push({ address: `${m[1]}.${m[2]}`, attr: m[3] });
  }
  return refs;
}

/** Collect every `${...}` reference reachable in a block's value tree. */
function refsInValue(value: unknown): RawRef[] {
  const refs: RawRef[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(INTERPOLATION)) refs.push(...refsFromExpression(m[1]));
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) visit(inner);
    }
  };
  visit(value);
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
export function buildGraph(tree: Hcl2JsonTree): TfGraph {
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
      const refs = refsInValue(block);
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
    const refs = refsInValue(block);
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
    const byTarget = new Map<string, Set<string>>();
    for (const ref of refs) {
      if (ref.address === from || !known.has(ref.address)) continue;
      if (!byTarget.has(ref.address)) byTarget.set(ref.address, new Set());
      if (ref.attr) byTarget.get(ref.address)!.add(ref.attr);
    }
    for (const [to, attrs] of byTarget) {
      edges.push({ from, to, attrs: [...attrs].sort() });
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
