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
 * ## A cloud index beside the workspace (#5245)
 *
 * A caller that reads a cluster and a cloud index together (behold's joined
 * read) hands the index's nodes to {@link runCatalogPass} as one more member,
 * through {@link indexedMemberNodes}: the member is the index document's
 * scope key. The cloud kinds are scoped by no catalog, so they sit in the
 * workspace scope with no namespace, which every namespaced holder reaches
 * (`scopeOf` below, and the account-only key `reconstructIndexedEdges`
 * looks a holder's value up under). The index's own account and region are
 * not part of that scope, so a rule that joins a cluster object to an
 * indexed node checks them itself: the IRSA rule keeps a role of the
 * annotation's account, the ExternalSecret rule a secret of the store's
 * region. `deriveEdgesAcross` (../lifecycle/derive-edges.ts) does not join
 * the two: it reads one cloud account, and refuses a cluster source.
 *
 * ## Declared nodes the rules are not written against
 *
 * A catalog's `declaredNode` gives the node the rules read, for a lexicon
 * whose declared nodes are not shaped like its rules: terraform's are all
 * `Terraform::Resource`, with their arguments under `body`. An instance node
 * is handed its block node too, since its attrs stay on the block (#5117).
 * The view is read for this pass only; the document's nodes are unchanged.
 *
 * ## Generated nodes and repository paths (#5102)
 *
 * A catalog's `generates` rules make nodes from a node: an ApplicationSet's
 * generators yield Applications. The pass reads each generated node with the
 * others, so the rules join it as they join a declared node of its kind, and
 * draws a derived edge from the holder to it. A node a generator made for a
 * cluster registration it selected gets an edge to that registration under
 * the rule's `cluster` id, and no other rule's edge for that pair. {@link placeCatalogPass} adds
 * it to `nodes` with `generatedBy`, and marks the holder with `expansion`:
 * how many it generated and what it did not expand.
 *
 * A generate rule's `files` reads the files a generated node names, when the
 * caller hands the pass `readFile` (#5094): a generated Application's Helm
 * values files become nodes, with the objects under their `extraObjects`,
 * as they do for an Application written by hand. Each is `<holder
 * id>/<key>`, in the holder's member, with `generatedBy` naming the
 * generated node and `generator: "file"`, and the rules read it with the
 * rest.
 *
 * A catalog's `pathRefs` rules read the paths in a repository a node names.
 * The caller says, through `lookPath`, whether each is in the workspace's
 * repository; one that is not there, or is a file where a directory is
 * named, goes in `dangling`. A path in another repository is not read. On a
 * generated node the entry names the holder as `through` and the cluster
 * registration the node was made for as `cluster`.
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
  memberRegion,
  reconstructIndexedEdges,
  readPath,
  refRuleId,
  type ContainmentPair,
  type GenerateRule,
  type RepoPathRef,
  type IndexedNodeScope,
  type NamedCatalog,
} from "../graph-refs";
import type { IREdge } from "../graph-ir";
import { nodeAttrsAt, type DetailLevel } from "../graph-detail";
import type {
  CatalogRuleEntry,
  CatalogSummary,
  ComposedAmbiguous,
  ComposedDangling,
  ComposedEdge,
  ComposedNode,
  NodeExpansion,
  WorkspaceGraph,
} from "./compose-graph";
import { composedId, danglingKey } from "./compose-graph";
import type { IndexDocument } from "../lifecycle/index-document";

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
  /** Nodes a catalog's `sharedNodes` added (#5100), with their ids as the document gives them. */
  shared: ComposedNode[];
  /** The nodes the catalogs' `generates` rules made (#5102), as the pass read them, each with `generatedBy`. */
  generated: ComposedNode[];
  /** By holder id: what a `generates` rule made of it. */
  expansions: Record<string, NodeExpansion>;
}

/** The text of a workspace-relative file in the workspace's repository, or undefined when it is not there (#5094). */
export type ReadFile = (path: string) => string | undefined;

/** Whether a repository path is in the workspace's repository: what it is there, `missing`, or undefined when the path is in another repository and is not read. */
export type LookPath = (ref: RepoPathRef) => "dir" | "file" | "missing" | undefined;

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
    for (const g of catalog.generates ?? []) {
      add(refRuleId(lexicon, g.from, g.path), { lexicon, from: g.from, path: g.path, relation: "reference", ...(g.label ? { label: g.label } : {}) }, g.targetKind);
      if (g.cluster) add(refRuleId(lexicon, g.from, g.cluster.path), { lexicon, from: g.from, path: g.cluster.path, relation: "reference", ...(g.cluster.label ? { label: g.cluster.label } : {}) }, g.cluster.targetKind);
    }
    for (const p of catalog.pathRefs ?? []) {
      add(refRuleId(lexicon, p.from, p.path), { lexicon, from: p.from, path: p.path, relation: "reference", ...(p.label ? { label: p.label } : {}) }, undefined);
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
 * `lookPath` finds a path rule's paths in the repository; without it no path
 * is read. `readFile` reads a file a generated node names (#5094); without
 * it no such file is read.
 */
export function runCatalogPass(nodes: readonly ComposedNode[], catalogs: readonly NamedCatalog[], members?: readonly string[], lookPath?: LookPath, readFile?: ReadFile): CatalogPass {
  const byLexicon = new Map(catalogs.map((c) => [c.lexicon, c.catalog]));
  const nonLiteral: Record<string, number> = {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const read: ComposedNode[] = nodes.map((n) => {
    const view = byLexicon.get(n.lexicon)?.declaredNode?.(n, n.instanceOf !== undefined ? byId.get(n.instanceOf) : undefined);
    if (!view) return n;
    if (view.nonLiteral > 0) nonLiteral[n.id] = view.nonLiteral;
    return { ...n, kind: view.kind, attrs: view.attrs };
  });

  // Generated nodes (#5102), made from the nodes as the rules read them.
  const generated: ComposedNode[] = [];
  const expansions: Record<string, NodeExpansion> = {};
  const generatedEdges: ComposedEdge[] = [];
  // A generated node's cluster registration, when its generator selected one: another rule's edge to it is left out.
  const selectedFor = new Map<string, string>();
  const withFiles: Array<{ rule: GenerateRule; ruleId: string; holder: ComposedNode; node: ComposedNode }> = [];
  for (const holder of read) {
    for (const rule of byLexicon.get(holder.lexicon)?.generates ?? []) {
      if (rule.from !== holder.kind) continue;
      const id = refRuleId(holder.lexicon, rule.from, rule.path);
      const made = rule.generate(holder, read);
      let count = 0;
      for (const g of made.nodes) {
        const nodeId = `${holder.id}/${g.key}`;
        if (byId.has(nodeId) || generated.some((n) => n.id === nodeId)) continue;
        count++;
        const node: ComposedNode = {
          id: nodeId,
          kind: g.kind,
          lexicon: holder.lexicon,
          attrs: g.attrs,
          member: holder.member,
          ...(holder.nested !== undefined ? { nested: holder.nested } : {}),
          generatedBy: { node: holder.id, rule: id, generator: g.generator, params: g.params, ...(g.cluster ? { cluster: g.cluster.id } : {}) },
        };
        generated.push(node);
        if (rule.files && readFile) withFiles.push({ rule, ruleId: id, holder, node });
        generatedEdges.push({ from: holder.id, to: nodeId, kind: "ref", viaAttr: refViaAttr(rule.path), grain: "property", origin: "derived", rule: id, relation: "reference", member: holder.member });
        if (g.cluster && rule.cluster) {
          const clusterRule = refRuleId(holder.lexicon, rule.from, rule.cluster.path);
          generatedEdges.push({ from: nodeId, to: g.cluster.id, kind: "ref", viaAttr: "generatedBy", grain: "property", origin: "derived", rule: clusterRule, relation: "reference", member: holder.member });
          selectedFor.set(nodeId, g.cluster.id);
        }
      }
      expansions[holder.id] = { rule: id, generated: count, notExpanded: made.notExpanded };
    }
  }
  read.push(...generated);

  // The files a generated node names (#5094): its values files and their objects, one node per file under the holder.
  const fromFiles: ComposedNode[] = [];
  const fileIds = new Set<string>();
  for (const { rule, ruleId, holder, node } of withFiles) {
    for (const f of rule.files!(node, readFile!, read)) {
      const id = `${holder.id}/${f.key}`;
      if (byId.has(id) || fileIds.has(id)) continue;
      fileIds.add(id);
      fromFiles.push({
        id,
        kind: f.kind,
        lexicon: f.lexicon,
        attrs: f.attrs,
        member: holder.member,
        ...(holder.nested !== undefined ? { nested: holder.nested } : {}),
        generatedBy: { node: node.id, rule: ruleId, generator: "file", params: {} },
      });
    }
  }
  generated.push(...fromFiles);
  read.push(...fromFiles);
  const member = new Map(read.map((n) => [n.id, n.member]));

  // A kind a catalog scopes is looked up by its own kind alone: the lexicon that wrote the node is not the catalog's (a values file read by the k8s reader is a helm node).
  const scopePath = new Map<string, string | null>();
  for (const { catalog } of catalogs) for (const r of catalog.scopes ?? []) scopePath.set(r.kind, r.path ?? null);
  const scopeOf = (n: ComposedNode): IndexedNodeScope => {
    // Every holder also reaches the nodes its own member holds with no other scope (`member`).
    if (!scopePath.has(n.kind)) return { account: WORKSPACE_SCOPE, member: n.member };
    const path = scopePath.get(n.kind);
    // A kind scoped with no path is held by its member alone, whichever lexicon the member's other nodes are of.
    if (path === null) return { account: WORKSPACE_SCOPE, region: memberRegion(n.member), member: n.member };
    const named = readPath(n.attrs, path!).find((v) => v !== "");
    return { account: WORKSPACE_SCOPE, region: named !== undefined ? `${n.lexicon}:${named}` : `${n.lexicon}@${n.member}`, member: n.member };
  };
  const scopes = new Map(read.map((n) => [n.id, scopeOf(n)]));

  // Nodes that no member owns (#5100): placed in the member of the first holder, with an edge to each from every holder.
  const shared: ComposedNode[] = [];
  const sharedEdges: ComposedEdge[] = [];
  const sharedRules: Record<string, CatalogRuleEntry> = {};
  const kindOf = new Map(read.map((n) => [n.id, n.kind]));
  for (const { lexicon, catalog } of catalogs) {
    for (const s of catalog.sharedNodes?.(read) ?? []) {
      const holders = [...s.holders].sort((a, b) => byString(a.from, b.from));
      if (holders.length === 0) continue;
      const owner = member.get(holders[0].from);
      if (owner === undefined) continue;
      const id = composedId(owner, s.id);
      shared.push({ id, kind: s.kind, lexicon, attrs: s.attrs, member: owner });
      member.set(id, owner);
      for (const h of holders) {
        const from = kindOf.get(h.from);
        if (from === undefined || h.from === id) continue;
        const rule = refRuleId(lexicon, from, h.via);
        const prev = sharedRules[rule];
        const label = h.label ?? prev?.label;
        sharedRules[rule] = {
          lexicon,
          from,
          path: h.via,
          relation: "reference",
          targetKinds: [...new Set([...(prev?.targetKinds ?? []), s.kind])].sort(byString),
          ...(label ? { label } : {}),
        };
        sharedEdges.push({ from: h.from, to: id, kind: "ref", viaAttr: h.via, grain: "property", origin: "derived", rule, relation: "reference", member: member.get(h.from)! });
      }
    }
  }

  const found = reconstructIndexedEdges([...read, ...shared], catalogs, (n) => scopes.get(n.id) ?? { account: WORKSPACE_SCOPE, member: member.get(n.id) });
  const memberOf = (id: string) => member.get(id)!;
  return {
    shared,
    edges: [...generatedEdges, ...found.edges.filter((e) => selectedFor.get(e.from) !== e.to).map((e) => ({ ...e, member: memberOf(e.from) })), ...sharedEdges],
    containment: found.containment,
    dangling: [...pathDangling(read, byLexicon, lookPath), ...found.dangling.map((d) => ({
      from: d.from,
      kind: "ref" as const,
      path: d.path,
      value: d.value,
      member: memberOf(d.from),
      rule: d.rule,
      ...(d.targetKind ? { targetKind: d.targetKind } : {}),
      ...(d.through ? { through: d.through } : {}),
    }))],
    ambiguous: found.ambiguous.map((a) => ({ from: a.from, member: memberOf(a.from), rule: a.rule, path: a.path, value: a.value, candidates: a.candidates })),
    nonLiteral,
    rules: { ...catalogRules(catalogs), ...sharedRules },
    lexicons: catalogs.map((c) => c.lexicon).sort(byString),
    members: [...new Set(members ?? read.map((n) => n.member))].sort(byString),
    generated,
    expansions,
  };
}

/**
 * An index document's nodes as members of a catalog pass (#5245): each in the
 * member the document's scope key names, so they sit beside a cluster's
 * objects or a workspace's members in one {@link runCatalogPass}.
 */
export function indexedMemberNodes(doc: IndexDocument): ComposedNode[] {
  return doc.graph.nodes.map((n) => ({ ...n, member: doc.stamp.scopeKey }));
}

/** A rule path's first step, the `viaAttr` an edge it draws carries, as the pass's own rules do. */
const refViaAttr = (path: string): string => path.split(/[.[]/)[0] || path;

/** The repository paths the nodes name that `lookPath` does not find (#5102). */
function pathDangling(nodes: readonly ComposedNode[], byLexicon: ReadonlyMap<string, NamedCatalog["catalog"]>, lookPath: LookPath | undefined): ComposedDangling[] {
  if (!lookPath) return [];
  const out = new Map<string, ComposedDangling>();
  for (const node of nodes) {
    for (const rule of byLexicon.get(node.lexicon)?.pathRefs ?? []) {
      if (rule.from !== node.kind) continue;
      const id = refRuleId(node.lexicon, rule.from, rule.path);
      for (const ref of rule.read(node)) {
        const there = lookPath(ref);
        if (there === undefined || there === ref.type) continue;
        const by = node.generatedBy;
        out.set(`${node.id}\u0000${id}\u0000${ref.value}`, {
          from: node.id,
          kind: "ref",
          path: rule.path,
          value: ref.value,
          member: node.member,
          rule: id,
          ...(by ? { through: by.node, ...(by.cluster ? { cluster: by.cluster } : {}) } : {}),
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * Write a pass into the document. `placed` maps an id the pass read to the
 * id of the node the document draws it as at its detail tier; an id it does
 * not hold is kept as it is, except a generated node's, which is drawn where
 * its holder is (a node read from a generated node's file, where that node is). A generated node goes in `nodes` when its holder is drawn
 * as itself, with its attrs as `level` prints them.
 */
export function placeCatalogPass(graph: WorkspaceGraph, pass: CatalogPass, placed: ReadonlyMap<string, string> = new Map(), level: DetailLevel = 3): void {
  const holderOf = new Map(pass.generated.map((n) => [n.id, n.generatedBy!.node]));
  // A node read from a generated node's file (#5094) has that node as its holder, so the walk goes up to a node the document holds.
  const at = (id: string, depth = 0): string => {
    const holder = holderOf.get(id);
    if (holder === undefined || depth > 4) return placed.get(id) ?? id;
    const drawn = at(holder, depth + 1);
    return drawn === holder ? id : drawn;
  };
  addGenerated(graph, pass, at, level);
  if (pass.shared.length > 0) {
    const have = new Set(graph.nodes.map((n) => n.id));
    const added = pass.shared.filter((n) => !have.has(n.id));
    graph.nodes = [...graph.nodes, ...added].sort((a, b) => byString(a.id, b.id));
    for (const n of added) {
      const m = (graph.groups.byMember[n.member] ??= []);
      m.push(n.id);
      m.sort(byString);
      const l = ((graph.groups.byLexicon ??= {})[n.lexicon] ??= []);
      l.push(n.id);
      l.sort(byString);
    }
  }
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
    const moved = { ...d, from: at(d.from), ...(d.through ? { through: at(d.through) } : {}), ...(d.cluster ? { cluster: at(d.cluster) } : {}) };
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

/** The generated nodes whose holder the document draws as itself, and each holder's `expansion` (#5102). */
function addGenerated(graph: WorkspaceGraph, pass: CatalogPass, at: (id: string) => string, level: DetailLevel): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const [holder, expansion] of Object.entries(pass.expansions)) {
    const node = at(holder) === holder ? byId.get(holder) : undefined;
    if (node) node.expansion = expansion;
  }
  const added: ComposedNode[] = [];
  for (const n of pass.generated) {
    if (at(n.id) !== n.id || byId.has(n.id)) continue;
    const by = n.generatedBy!;
    added.push({ ...n, attrs: nodeAttrsAt(n.attrs, level), generatedBy: { ...by, ...(by.cluster ? { cluster: at(by.cluster) } : {}) } });
  }
  if (added.length === 0) return;
  graph.nodes = [...graph.nodes, ...added].sort((a, b) => a.id.localeCompare(b.id));
  const into = (group: Record<string, string[]>, key: string, id: string) => (group[key] = [...(group[key] ?? []), id].sort());
  for (const n of added) {
    into(graph.groups.byMember, n.member, n.id);
    if (graph.groups.byLexicon) into(graph.groups.byLexicon, n.lexicon, n.id);
  }
}

/** What a member's declared `runsOn` drew (#5101). */
export interface RunsOnEdges {
  /** One declared edge from each cluster registration of the member to the node `runsOn` names. */
  edges: ComposedEdge[];
  /** The registrations an edge was drawn from, so their unmatched references are not reported. */
  joined: Set<string>;
  /** A `runsOn` that drew nothing, and why. */
  problems: string[];
}

/**
 * The declared mapping from a cluster's registration to the cluster resource
 * (#5101), for a repo whose names do not match: a member's `runsOn`,
 * `<member>/<address>`, names the node the member runs on, by the member that
 * holds it and its address (the node's id without the member, or an
 * `attrs.address`). Each node of the member that its lexicon's
 * `registersCluster` accepts draws one `declared` edge to it. A target that
 * matches no node or several, a member with nothing that registers a cluster,
 * and a target in the member itself are problems that draw no edge.
 */
export function runsOnEdges(nodes: readonly ComposedNode[], runsOn: ReadonlyMap<string, string>, catalogs: readonly NamedCatalog[]): RunsOnEdges {
  const out: RunsOnEdges = { edges: [], joined: new Set(), problems: [] };
  const registers = new Map(catalogs.map((c) => [c.lexicon, c.catalog.registersCluster]));
  for (const [member, target] of [...runsOn].sort((a, b) => byString(a[0], b[0]))) {
    const slash = target.indexOf("/");
    const targetMember = target.slice(0, slash);
    const address = target.slice(slash + 1);
    const matches = nodes.filter((n) => n.member === targetMember && (n.id === `${targetMember}/${address}` || n.id.endsWith(`/${address}`) || n.attrs?.address === address));
    if (matches.length !== 1) {
      out.problems.push(
        matches.length === 0
          ? `member ${member} runs on ${target}, which matches no node of ${targetMember}; no edge is drawn`
          : `member ${member} runs on ${target}, which matches ${matches.length} nodes (${matches.map((n) => n.id).join(", ")}); no edge is drawn`,
      );
      continue;
    }
    const registrations = nodes.filter((n) => n.member === member && registers.get(n.lexicon)?.(n) === true);
    if (registrations.length === 0) {
      out.problems.push(`member ${member} runs on ${target}, and holds no cluster registration to join to it; no edge is drawn`);
      continue;
    }
    for (const r of registrations) {
      if (r.id === matches[0].id) continue;
      out.joined.add(r.id);
      out.edges.push({ from: r.id, to: matches[0].id, kind: "ref", viaAttr: "runsOn", origin: "declared", member });
    }
  }
  return out;
}
