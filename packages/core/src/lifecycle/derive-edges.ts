/**
 * Derived edges for indexed resources (#4522, tier 1 of INTENTIUS/behold#1025,
 * rules ruled on INTENTIUS/behold#1023 2026-10-26).
 *
 * An index typed by ./type-listing.ts has nodes and no edges: with no project
 * there are no declared references. {@link deriveEdges} runs each lexicon's
 * `referenceCatalog` (the one `chant graph --live` uses, #778) over the
 * indexed nodes through `reconstructIndexedEdges` (../graph-refs.ts), and
 * writes what it finds into the document:
 *
 * - every edge is `origin: "derived"` with the `rule` that drew it and
 *   `grain: "property"`; containment edges say `relation: "containment"` and
 *   fill `groups.byContainer`;
 * - the join key is the scoped value: substrate and account, subscription,
 *   project or cluster, plus region for a regional type, account only for a
 *   global one (Q2);
 * - a value matching several nodes draws no edge; an `ambiguous-reference`
 *   note records it with every candidate (Q3);
 * - a reference to nothing in the index goes in `graph.dangling`;
 * - tags make edges only through a catalog's typed tag rules (Q5);
 * - a lexicon with no catalog is named in a `no-catalog` note, and its nodes
 *   get no derived edges: nothing guesses;
 * - derivation runs over every document of one account from the same read
 *   (Q7, {@link deriveEdgesAcross}), and each edge is stored in its holder's
 *   document. Edges are per read and never carried to another read.
 *
 * After the catalog pass, the identity-match pass (#4523, behold#1023 Q1)
 * runs over the same nodes: an attribute value equal to the native id or ARN
 * of a node whose lexicon declares an `indexIdentity` draws an edge whose
 * `rule` starts `identity-match:`, under the same scoped join key, and a
 * value naming several nodes draws none and is recorded in an
 * `ambiguous-identity` note with every candidate. A pair the catalog joined
 * gets no second edge. Pure.
 */
import type { GraphIR, IRDanglingRef, IRNode } from "../graph-ir";
import {
  containmentGroups,
  reconstructIdentityEdges,
  reconstructIndexedEdges,
  type IdentityOwners,
  type IndexedNodeScope,
  type NamedCatalog,
  type ReferenceCatalog,
} from "../graph-refs";
import type { IndexIdentity } from "./identity-match";
import { indexDocumentDigest, type IndexDocument, type IndexNote } from "./index-document";

/** What {@link deriveEdges} needs from a lexicon. A `LexiconPlugin` is one. */
export interface EdgeLexicon {
  name: string;
  referenceCatalog?: ReferenceCatalog;
  /** Its identity rule (#4523): when present, the identity-match pass can name this lexicon's nodes. */
  indexIdentity?: IndexIdentity;
}

/** Locations that hold global types: AWS's `global`, Kubernetes' cluster-scoped objects. */
const GLOBAL_LOCATIONS: ReadonlySet<string> = new Set(["global", "cluster", ""]);

/** The scope an indexed node's identifiers are unique in, from its document's stamp and its own location. */
export function indexedNodeScope(doc: IndexDocument, node: IRNode): IndexedNodeScope {
  const scope = doc.stamp.scope;
  const account = scope.kind === "cloud" ? `${scope.substrate}/${scope.scopeId}` : doc.stamp.scopeKey;
  const location = node.location ?? "";
  return GLOBAL_LOCATIONS.has(location) ? { account } : { account, region: location };
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function noteKey(n: IndexNote): string {
  return `${n.kind}\u0000${n.listedType ?? ""}\u0000${n.location ?? ""}\u0000${n.message}`;
}

/** Derived edges over one index document. */
export function deriveEdges(doc: IndexDocument, lexicons: readonly EdgeLexicon[]): IndexDocument {
  return deriveEdgesAcross([doc], lexicons)[0];
}

/**
 * Derived edges over every document of one account from one read (behold#1023
 * Q7): regional documents and an account-level one for global types, or the
 * single document a `behold index` run writes (behold#1025 Q6). The documents
 * must be cloud reads of one substrate and scope id with one `observedAt`;
 * anything else is refused, because joining two reads would carry a name from
 * one read to an object of another.
 */
export function deriveEdgesAcross(docs: readonly IndexDocument[], lexicons: readonly EdgeLexicon[]): IndexDocument[] {
  if (docs.length === 0) return [];
  const first = docs[0].stamp;
  for (const d of docs) {
    const s = d.stamp.scope;
    if (s.kind !== "cloud" || first.scope.kind !== "cloud") {
      throw new Error(`derived edges run over cloud index documents; ${d.stamp.scopeKey} is a ${s.kind} source`);
    }
    if (s.substrate !== first.scope.substrate || s.scopeId !== first.scope.scopeId) {
      throw new Error(`derived edges run over one account: ${first.scope.substrate}/${first.scope.scopeId} and ${s.substrate}/${s.scopeId} are two`);
    }
    if (d.stamp.observedAt !== first.observedAt) {
      throw new Error(`derived edges run over one read: ${first.observedAt} and ${d.stamp.observedAt} are two`);
    }
  }

  const named: NamedCatalog[] = [...lexicons]
    .filter((l): l is EdgeLexicon & { referenceCatalog: ReferenceCatalog } => l.referenceCatalog !== undefined)
    .sort((a, b) => byString(a.name, b.name))
    .map((l) => ({ lexicon: l.name, catalog: l.referenceCatalog }));
  const withCatalog = new Set(named.map((c) => c.lexicon));

  const holderDoc = new Map<string, number>();
  const scopes = new Map<string, IndexedNodeScope>();
  const all: IRNode[] = [];
  docs.forEach((d, i) => {
    for (const n of d.graph.nodes) {
      holderDoc.set(n.id, i);
      scopes.set(n.id, indexedNodeScope(d, n));
      all.push(n);
    }
  });

  const derived = reconstructIndexedEdges(all, named, (n) => scopes.get(n.id)!);
  const owners: IdentityOwners[] = [...lexicons]
    .filter((l) => l.indexIdentity !== undefined)
    .sort((a, b) => byString(a.name, b.name))
    .map((l) => ({ lexicon: l.name, ...(l.indexIdentity!.nodeIdentities ? { identities: l.indexIdentity!.nodeIdentities } : {}) }));
  const identity = owners.length > 0
    ? reconstructIdentityEdges(all, owners, (n) => scopes.get(n.id)!, derived.edges)
    : { edges: [], ambiguous: [] };

  return docs.map((d, i) => {
    const mine = (from: string) => holderDoc.get(from) === i;
    const edges = [...d.graph.edges.filter((e) => e.origin !== "derived"), ...derived.edges.filter((e) => mine(e.from)), ...identity.edges.filter((e) => mine(e.from))];
    const pairs = derived.containment.filter((p) => mine(p.child));
    const dangling = new Map<string, IRDanglingRef>();
    for (const r of [
      ...(d.graph.dangling ?? []),
      ...derived.dangling.filter((x) => mine(x.from)).map((x) => ({ from: x.from, kind: "ref" as const, path: x.path, value: x.value })),
    ]) {
      dangling.set(`${r.from}\u0000${r.kind}\u0000${r.path}\u0000${r.value}`, r);
    }

    const notes: IndexNote[] = (d.notes ?? []).filter((n) => n.kind !== "no-catalog" && n.kind !== "ambiguous-reference" && n.kind !== "ambiguous-identity");
    for (const a of derived.ambiguous.filter((x) => mine(x.from))) {
      notes.push({
        kind: "ambiguous-reference",
        message: `${a.from} ${a.path} = ${JSON.stringify(a.value)} matches ${a.candidates.length} nodes (${a.candidates.join(", ")}); rule ${a.rule} drew no edge`,
      });
    }
    for (const a of identity.ambiguous.filter((x) => mine(x.from))) {
      notes.push({
        kind: "ambiguous-identity",
        message: `${a.from} ${a.path} = ${JSON.stringify(a.value)} names ${a.candidates.length} nodes (${a.candidates.join(", ")}); the identity-match pass drew no edge`,
      });
    }
    const counts = new Map<string, number>();
    for (const n of d.graph.nodes) if (!n.unmappedKind) counts.set(n.lexicon, (counts.get(n.lexicon) ?? 0) + 1);
    for (const lexicon of [...counts.keys()].sort()) {
      if (withCatalog.has(lexicon)) continue;
      notes.push({
        kind: "no-catalog",
        message: `the ${lexicon} lexicon has no referenceCatalog, so its ${counts.get(lexicon)} node(s) have no derived edges`,
      });
    }
    notes.sort((a, b) => byString(noteKey(a), noteKey(b)));

    const groups = { ...d.graph.groups };
    const byContainer = containmentGroups(pairs);
    if (Object.keys(byContainer).length > 0) groups.byContainer = byContainer;
    else delete groups.byContainer;

    const graph: GraphIR = { ...d.graph, edges, groups };
    if (dangling.size > 0) graph.dangling = [...dangling.values()];
    else delete graph.dangling;

    const out: IndexDocument = {
      ...d,
      stamp: { ...d.stamp, digest: indexDocumentDigest({ graph, coverage: d.coverage }) },
      graph,
    };
    if (notes.length > 0) out.notes = notes;
    else delete out.notes;
    return out;
  });
}
