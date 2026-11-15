/**
 * The reference catalog over a composed workspace graph (#5097, phase 3 of
 * INTENTIUS/behold#1049).
 *
 * Each lexicon's `referenceCatalog` says how its resources name each other.
 * It ran over a live read and over a cloud index (#4522), never over the
 * declared graph `chant workspace graph` composes, so no edge went from one
 * member to another except through links. {@link runCatalogPass} runs
 * `reconstructIndexedEdges` (../graph-refs.ts) over every composed node, and
 * {@link placeCatalogPass} writes what it found into the document:
 *
 * - each edge it draws goes in `edges` with `origin: "derived"`, the `rule`
 *   that drew it, its `relation` and `grain: "property"`, and the holder's
 *   `member`. A pair the declared graph already joins gets no second edge;
 * - a reference that names no node goes in `dangling`, with its `rule` and
 *   the `targetKind` the rule looks for;
 * - a reference that names more than one node draws no edge and goes in
 *   `ambiguous` with every candidate;
 * - `catalog` names the lexicons whose catalog ran, the members read, each
 *   rule the document names, and per node the arguments it could not read.
 *
 * ## Scopes
 *
 * A Kubernetes name is unique inside its namespace, while a rule from a
 * Kubernetes object to a cloud resource has to reach a node of another
 * member. The pass keeps one scope per node and uses the index's two-level
 * lookup for both: every node sits in the workspace, and a node of a kind its
 * catalog lists in `scopes` also sits in the scope that kind names, its
 * namespace. A holder in a namespace reaches the nodes of that namespace in
 * any member, and every node that has no namespace. A holder with no
 * namespace reaches only nodes with none. One of those kinds whose node names
 * no namespace sits in a scope of its own member, since chant cannot tell
 * where it will be applied, and the objects one member applies together go to
 * one namespace far more often than not.
 *
 * ## Declared nodes the rules are not written against
 *
 * A catalog's `declaredNode` gives the node the rules read, for a lexicon
 * whose declared nodes are not shaped like its rules: terraform's are all
 * `Terraform::Resource`, with their arguments under `body`. The view is read
 * for this pass only; the document's nodes are unchanged.
 *
 * ## Detail tiers
 *
 * The pass reads every node with its full attributes, whatever `--detail` the
 * document is printed at. At T1 and T0 an edge, a dangling holder and the
 * candidates move to the node they are drawn as ({@link detailIdMap}), and an
 * edge both of whose ends land on one node is dropped, as T1 drops an edge
 * inside a composite.
 *
 * Pure.
 */

import {
  containmentGroups,
  reconstructIndexedEdges,
  readPath,
  refRuleId,
  type ContainmentPair,
  type IndexedNodeScope,
  type NamedCatalog,
} from "../graph-refs";
import type { IREdge } from "../graph-ir";
import type {
  CatalogRuleEntry,
  CatalogSummary,
  ComposedAmbiguous,
  ComposedDangling,
  ComposedEdge,
  ComposedNode,
  WorkspaceGraph,
} from "./compose-graph";
import { danglingKey } from "./compose-graph";

/** The scope every node of a declared workspace graph sits in. */
export const WORKSPACE_SCOPE = "workspace";

/** What the catalog pass found, on the ids of the nodes it read. */
export interface CatalogPass {
  edges: ComposedEdge[];
  containment: ContainmentPair[];
  dangling: ComposedDangling[];
  ambiguous: ComposedAmbiguous[];
  /** By node id: arguments left unread because they are not literal. */
  nonLiteral: Record<string, number>;
  /** Every rule of the catalogs, by rule id. */
  rules: Record<string, CatalogRuleEntry>;
  lexicons: string[];
  members: string[];
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each rule of the catalogs by id. Rules that share an id (one per target kind) share an entry. */
export function catalogRules(catalogs: readonly NamedCatalog[]): Record<string, CatalogRuleEntry> {
  const out: Record<string, CatalogRuleEntry> = {};
  const add = (id: string, entry: Omit<CatalogRuleEntry, "targetKinds">, targetKind: string | undefined): void => {
    const prev = out[id];
    const kinds = new Set(prev?.targetKinds ?? []);
    if (targetKind !== undefined) kinds.add(targetKind);
    out[id] = { ...entry, ...(prev?.label !== undefined && entry.label === undefined ? { label: prev.label } : {}), targetKinds: [...kinds].sort(byString) };
  };
  for (const { lexicon, catalog } of catalogs) {
    for (const r of catalog.refs) {
      add(refRuleId(lexicon, r.from, r.path), { lexicon, from: r.from, path: r.path, relation: r.relation, ...(r.label ? { label: r.label } : {}) }, r.targetKind ?? r.indexedTargetKind);
    }
    for (const t of catalog.tagRefs ?? []) {
      const from = t.from ?? "*";
      add(refRuleId(lexicon, from, `tag:${t.key}`), { lexicon, from, path: `tag:${t.key}`, relation: "reference", ...(t.label ? { label: t.label } : {}) }, t.targetKind);
    }
  }
  return out;
}

/**
 * Run the catalogs over composed nodes, each read with its full attributes.
 * Rules apply to nodes of their own lexicon; targets can be any node.
 * `members` names the members read, the nodes' own members by default.
 */
export function runCatalogPass(nodes: readonly ComposedNode[], catalogs: readonly NamedCatalog[], members?: readonly string[]): CatalogPass {
  const byLexicon = new Map(catalogs.map((c) => [c.lexicon, c.catalog]));
  const nonLiteral: Record<string, number> = {};
  const read: ComposedNode[] = nodes.map((n) => {
    const view = byLexicon.get(n.lexicon)?.declaredNode?.(n);
    if (!view) return n;
    if (view.nonLiteral > 0) nonLiteral[n.id] = view.nonLiteral;
    return { ...n, kind: view.kind, attrs: view.attrs };
  });
  const member = new Map(read.map((n) => [n.id, n.member]));

  const scopePath = new Map<string, string>();
  for (const { lexicon, catalog } of catalogs) for (const r of catalog.scopes ?? []) scopePath.set(`${lexicon}\u0000${r.kind}`, r.path);
  const scopeOf = (n: ComposedNode): IndexedNodeScope => {
    const path = scopePath.get(`${n.lexicon}\u0000${n.kind}`);
    if (path === undefined) return { account: WORKSPACE_SCOPE };
    const named = readPath(n.attrs, path).find((v) => v !== "");
    return { account: WORKSPACE_SCOPE, region: named !== undefined ? `${n.lexicon}:${named}` : `${n.lexicon}@${n.member}` };
  };
  const scopes = new Map(read.map((n) => [n.id, scopeOf(n)]));

  const found = reconstructIndexedEdges(read, catalogs, (n) => scopes.get(n.id)!);
  const memberOf = (id: string) => member.get(id)!;
  return {
    edges: found.edges.map((e) => ({ ...e, member: memberOf(e.from) })),
    containment: found.containment,
    dangling: found.dangling.map((d) => ({
      from: d.from,
      kind: "ref" as const,
      path: d.path,
      value: d.value,
      member: memberOf(d.from),
      rule: d.rule,
      ...(d.targetKind ? { targetKind: d.targetKind } : {}),
      ...(d.through ? { through: d.through } : {}),
    })),
    ambiguous: found.ambiguous.map((a) => ({ from: a.from, member: memberOf(a.from), rule: a.rule, path: a.path, value: a.value, candidates: a.candidates })),
    nonLiteral,
    rules: catalogRules(catalogs),
    lexicons: catalogs.map((c) => c.lexicon).sort(byString),
    members: [...new Set(members ?? read.map((n) => n.member))].sort(byString),
  };
}

/**
 * Write a pass into the document. `placed` maps an id the pass read to the
 * id of the node the document draws it as at its detail tier; an id it does
 * not hold is kept as it is.
 */
export function placeCatalogPass(graph: WorkspaceGraph, pass: CatalogPass, placed: ReadonlyMap<string, string> = new Map()): void {
  const at = (id: string) => placed.get(id) ?? id;
  const joined = new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}`));
  const named = new Set<string>();

  const edges = new Map<string, ComposedEdge>();
  for (const e of pass.edges) {
    const from = at(e.from);
    const to = at(e.to);
    if (from === to || joined.has(`${from}\u0000${to}`)) continue;
    const key = `${from}\u0000${to}\u0000${e.viaAttr ?? ""}\u0000${e.relation ?? ""}`;
    const prev = edges.get(key);
    if (!prev || byString(e.rule!, prev.rule!) < 0) edges.set(key, { ...e, from, to });
  }
  for (const e of edges.values()) named.add(e.rule!);
  const edgeKey = (e: IREdge) => `${e.from}\u0000${e.to}\u0000${e.viaAttr ?? ""}`;
  graph.edges = [...graph.edges, ...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  const dangling = new Map<string, ComposedDangling>();
  for (const d of graph.dangling ?? []) dangling.set(`${danglingKey(d)}\u0000${d.rule ?? ""}\u0000${d.through ?? ""}`, d);
  for (const d of pass.dangling) {
    const moved = { ...d, from: at(d.from), ...(d.through ? { through: at(d.through) } : {}) };
    dangling.set(`${danglingKey(moved)}\u0000${moved.rule ?? ""}\u0000${moved.through ?? ""}`, moved);
    named.add(d.rule!);
  }
  if (dangling.size > 0) graph.dangling = [...dangling.values()].sort((a, b) => danglingKey(a).localeCompare(danglingKey(b)) || byString(a.rule ?? "", b.rule ?? "") || byString(a.through ?? "", b.through ?? ""));

  const ambiguous = new Map<string, ComposedAmbiguous>();
  for (const a of pass.ambiguous) {
    const moved = { ...a, from: at(a.from), candidates: [...new Set(a.candidates.map(at))].sort(byString) };
    ambiguous.set(`${moved.from}\u0000${moved.rule}\u0000${moved.value}`, moved);
    named.add(a.rule);
  }
  const ambiguousKey = (a: ComposedAmbiguous) => `${a.from}\u0000${a.rule}\u0000${a.value}`;
  if (ambiguous.size > 0) graph.ambiguous = [...ambiguous.values()].sort((a, b) => byString(ambiguousKey(a), ambiguousKey(b)));

  // Containment fills the boundary boxes, on the nodes the document draws.
  const pairs = pass.containment
    .map((p) => ({ ...p, child: at(p.child), parent: at(p.parent) }))
    .filter((p) => p.child !== p.parent);
  const byContainer = containmentGroups(pairs);
  if (Object.keys(byContainer).length > 0) {
    const merged: Record<string, string[]> = { ...(graph.groups.byContainer ?? {}) };
    for (const [k, v] of Object.entries(byContainer)) merged[k] = [...new Set([...(merged[k] ?? []), ...v])].sort(byString);
    graph.groups.byContainer = Object.fromEntries(Object.keys(merged).sort(byString).map((k) => [k, merged[k]]));
  }

  const nonLiteral: Record<string, number> = {};
  for (const [id, n] of Object.entries(pass.nonLiteral)) nonLiteral[at(id)] = (nonLiteral[at(id)] ?? 0) + n;
  const summary: CatalogSummary = {
    lexicons: pass.lexicons,
    members: pass.members,
    rules: Object.fromEntries([...named].filter((id) => pass.rules[id]).sort(byString).map((id) => [id, pass.rules[id]])),
  };
  if (Object.keys(nonLiteral).length > 0) summary.nonLiteral = Object.fromEntries(Object.keys(nonLiteral).sort(byString).map((k) => [k, nonLiteral[k]]));
  graph.catalog = summary;
}
