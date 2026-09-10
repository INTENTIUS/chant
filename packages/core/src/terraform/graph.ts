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

import { shapeSourcePaths } from "./data-source-shape";
import { dataSourceShapeOf, identityAttrOf } from "./tier-map";
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
 * The referrer key a `local.<name>` accessor names, or null for anything else.
 *
 * `refFromAccessor` is right to refuse `local.*`: a local is a substitution,
 * has no address in the plan graph, and nothing carves one. But the resource a
 * local ultimately names is a dependency all the same, so the accessor is
 * carried this far to be resolved through the locals table (#2324) rather than
 * dropped at the resource-head guard.
 */
function localKeyFromAccessor(accessor: string): string | null {
  const parts = accessorSegments(accessor);
  const name = parts[1];
  return parts[0] === "local" && name !== undefined && NAME.test(name) ? `local.${name}` : null;
}

/**
 * Every string value carrying an interpolation across the tree's resource,
 * module, output, `locals` and `data` blocks — exactly the expressions
 * `parse.ts` must resolve through the AST before `buildGraph` can classify
 * them.
 *
 * `locals` and `data` are here because a reference can reach a resource
 * through them (#2324): a survivor reading `local.assets_id`, or a `data`
 * source keyed off the carved resource, is a dependency the plan breaks on
 * just as hard as a direct one. Skipping their bodies meant the AST never saw
 * those expressions at all.
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
  for (const blocks of Object.values(tree.output ?? {})) visit(blocks);
  visit(tree.locals);
  for (const named of Object.values(tree.data ?? {})) for (const blocks of Object.values(named)) visit(blocks);
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
        if (ref) {
          refs.push(ref);
          continue;
        }
        const localKey = localKeyFromAccessor(accessor);
        if (localKey) refs.push({ address: localKey });
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

/**
 * Non-node referrers: `local.<name>` and `data.<type>.<name>` → the references
 * in the body each one stands for (#2324).
 *
 * Neither is a graph node — a local is a substitution, and a data source is
 * not carvable infrastructure — but both sit on a path between a survivor and
 * a resource, which is the shape an `output` block already has here. A
 * `locals` block arrives from hcl2json as an array of its assignments, one
 * element per `locals` block in the estate.
 */
function referrerTable(tree: Hcl2JsonTree, exprRefs: ExpressionRefs): Map<string, RawRef[]> {
  const table = new Map<string, RawRef[]>();
  const add = (key: string, refs: RawRef[]): void => {
    const existing = table.get(key);
    if (existing) existing.push(...refs);
    else table.set(key, refs);
  };
  const localsBlocks = Array.isArray(tree.locals) ? tree.locals : tree.locals ? [tree.locals] : [];
  for (const block of localsBlocks) {
    if (!block || typeof block !== "object") continue;
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      add(`local.${name}`, refsInValue(value, exprRefs));
    }
  }
  for (const [type, named] of Object.entries(tree.data ?? {})) {
    for (const [name, blocks] of Object.entries(named)) {
      add(`data.${type}.${name}`, refsInBlock(Array.isArray(blocks) ? blocks[0] : blocks, exprRefs));
    }
  }
  return table;
}

/** Identity of a reference for de-duplication: the address plus the attribute read off it. */
function refKey(ref: RawRef): string {
  return `${ref.address}\u0000${ref.attr ?? ""}`;
}

/**
 * Resolve every referrer entry to the node references it ultimately names.
 *
 * One substitution pass is not enough: a local can read another local, and a
 * `data` source can read a local that reads another data source. So this
 * iterates to a fixpoint — each round replaces a referrer key appearing in an
 * entry with that key's own resolved references, and the loop stops when a
 * round adds nothing new.
 *
 * Growth is monotone and bounded by (referrers x distinct references), so a
 * self-referential local (`a = local.a`, skipped outright) or a cycle
 * (`a = local.b`, `b = local.a`) converges instead of recursing. Terraform
 * rejects both, but the advisor only reads an estate and must not hang on one
 * it disagrees with.
 */
function resolveReferrers(table: ReadonlyMap<string, RawRef[]>): Map<string, RawRef[]> {
  // Seed each entry with the references that already name something outside
  // the table; the loop then folds in what the referrer keys resolve to.
  const resolved = new Map<string, Map<string, RawRef>>();
  for (const [key, refs] of table) {
    resolved.set(key, new Map(refs.filter((r) => !table.has(r.address)).map((r) => [refKey(r), r])));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, refs] of table) {
      const into = resolved.get(key)!;
      for (const ref of refs) {
        if (ref.address === key) continue; // `a = local.a` — nothing to fold in but itself
        const from = resolved.get(ref.address);
        if (!from) continue;
        for (const [id, inner] of from) {
          if (into.has(id)) continue;
          into.set(id, inner);
          changed = true;
        }
      }
    }
  }
  return new Map([...resolved].map(([key, refs]) => [key, [...refs.values()]]));
}

/**
 * A block's references as the graph should see them: one that reaches a
 * `local` or `data` referrer additionally yields the node reference it
 * resolves to.
 *
 * The original reference is kept — a `data.*` address is what marks the
 * referring node dynamic, and an address that is not a node is dropped at edge
 * time anyway. The resolved reference keeps the referring block's own `via`
 * attribute, since that is what a deferred input is named after, and takes the
 * carried resource attribute from the referrer's body.
 */
function throughReferrers(refs: readonly RawRef[], resolved: ReadonlyMap<string, RawRef[]>): RawRef[] {
  const out: RawRef[] = [];
  for (const ref of refs) {
    out.push(ref);
    for (const inner of resolved.get(ref.address) ?? []) out.push({ ...inner, via: ref.via });
  }
  return out;
}

/** A block carries `count`/`for_each` → dynamic, single instance until state resolves it. */
function blockHasMeta(block: unknown, key: string): boolean {
  return !!block && typeof block === "object" && key in (block as Record<string, unknown>);
}

/**
 * The literal string at a dotted path into a block, or undefined when the path
 * misses or lands on an interpolation. A dotted path walks nested blocks —
 * hcl2json renders a nested block as a one-element array, so arrays step
 * through their first element (`manifest.metadata.name`).
 */
function literalAt(block: unknown, path: string): string | undefined {
  let value: unknown = block;
  for (const segment of path.split(".")) {
    if (Array.isArray(value)) value = value[0];
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string" || value.includes("${")) return undefined;
  return value;
}

/**
 * The resource's physical name, if its identity attribute is a plain literal
 * (not interpolated).
 */
function literalIdentity(block: unknown, type: string): string | undefined {
  const attr = identityAttrOf(type);
  if (!attr || !block || typeof block !== "object") return undefined;
  return literalAt(block, attr);
}

/**
 * The literals the type's data-source shape reads out of the carved block
 * (#2034), keyed by the shape field's source path. `carve bridge` renders the
 * data-source body from these; a required field missing here is what makes it
 * write a TODO instead of a block Terraform would reject.
 */
function dataSourceValues(block: unknown, type: string): Record<string, string> | undefined {
  if (!block || typeof block !== "object") return undefined;
  const shape = dataSourceShapeOf(type);
  if (!shape) return undefined;
  const values: Record<string, string> = {};
  for (const path of shapeSourcePaths(shape)) {
    const value = literalAt(block, path);
    if (value !== undefined) values[path] = value;
  }
  return Object.keys(values).length ? values : undefined;
}

/**
 * Build the dependency graph from a merged hcl2json tree.
 *
 * `resource` and `module` blocks become nodes. `data` sources are NOT nodes
 * (they are not carvable infrastructure), but a reference *to* a data source
 * marks the referring node dynamic. An edge is recorded only when its target
 * resolves to a known resource/module node — references to `var`/`local`/data
 * are dropped.
 *
 * `output` blocks are not nodes either — nothing carves an output — but they
 * do reference, and a reference to a carved resource breaks the surviving plan
 * exactly like a resource's does. So an output contributes an edge tagged
 * `fromKind: "output"` from the pseudo-address `output.<name>` (#1638),
 * which the scorer weights lower and `carve bridge` patches.
 *
 * `locals` and `data` blocks are non-node referrers of a third kind (#2324):
 * they carry a reference between two nodes rather than terminating it. A
 * survivor reading `local.assets_id`, or reading a `data` source keyed off the
 * carved resource, depends on that resource, so the reference is resolved
 * through the referrer to the resource it ultimately names and the edge is
 * recorded against the surviving node — the thing a reader can actually carve
 * or leave behind. The referrer's own body is where `carve bridge` then lands
 * the rewrite.
 */
export function buildGraph(tree: Hcl2JsonTree, exprRefs: ExpressionRefs): TfGraph {
  const nodes: TfNode[] = [];
  const dataAddresses = new Set<string>();
  const referrers = resolveReferrers(referrerTable(tree, exprRefs));

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
      const refs = throughReferrers(refsInBlock(block, exprRefs), referrers);
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
        dataSourceValues: dataSourceValues(block, type),
      });
    }
  }

  // Module nodes.
  for (const [name, blocks] of Object.entries(tree.module ?? {})) {
    const address = `module.${name}`;
    const block = Array.isArray(blocks) ? blocks[0] : blocks;
    const dynamic = blockHasMeta(block, "count") || blockHasMeta(block, "for_each");
    const refs = throughReferrers(refsInBlock(block, exprRefs), referrers);
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

  // Output blocks: referrers without being nodes (#1638). Their pseudo-address
  // never joins `known`, so nothing can depend on an output in turn.
  const outputRefs = new Map<string, RawRef[]>();
  for (const [name, blocks] of Object.entries(tree.output ?? {})) {
    const block = Array.isArray(blocks) ? blocks[0] : blocks;
    outputRefs.set(`output.${name}`, throughReferrers(refsInBlock(block, exprRefs), referrers));
  }

  // Edges: keep only references that resolve to a known node.
  const known = new Set(nodes.map((n) => n.address));
  const edges: TfEdge[] = [];
  const collect = (source: Map<string, RawRef[]>, fromKind?: "output"): void => {
    for (const [from, refs] of source) {
      const byTarget = new Map<string, { attrs: Set<string>; via: Set<string> }>();
      for (const ref of refs) {
        if (ref.address === from || !known.has(ref.address)) continue;
        if (!byTarget.has(ref.address)) byTarget.set(ref.address, { attrs: new Set(), via: new Set() });
        const target = byTarget.get(ref.address)!;
        if (ref.attr) target.attrs.add(ref.attr);
        if (ref.via) target.via.add(ref.via);
      }
      for (const [to, { attrs, via }] of byTarget) {
        edges.push({ from, to, attrs: [...attrs].sort(), via: [...via].sort(), ...(fromKind ? { fromKind } : {}) });
      }
    }
  };
  collect(rawRefsByNode);
  collect(outputRefs, "output");

  // Code-point ordering (not localeCompare) so output is locale-independent and
  // punctuation sorts predictably (`.` < `_`).
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    nodes: nodes.sort((a, b) => cmp(a.address, b.address)),
    edges: edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
  };
}

/** Edges where something in the surviving Terraform depends on `address`. */
export function inboundEdges(graph: TfGraph, address: string): TfEdge[] {
  return graph.edges.filter((e) => e.to === address);
}

/** Edges where `address` depends on other nodes (each → a deferred deploy-time input). */
export function outboundEdges(graph: TfGraph, address: string): TfEdge[] {
  return graph.edges.filter((e) => e.from === address);
}
