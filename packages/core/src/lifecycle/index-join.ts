/**
 * `chant search --index <ref>` (#4525): an index version as the observed side
 * of a search, joined to the declared rows.
 *
 * Two halves, both pure apart from {@link readIndexRef}'s store read:
 *
 * - a ref names one index version in the store (#4519, ./index-document.ts):
 *   `<scope key>`, `<scope key>@latest`, `<scope key>@<version>` or
 *   `<scope key>/<version>.json`, where the scope key is `stamp.scopeKey`
 *   (`cloud/aws/<account>/<scope digest>`) and a version is a name the store
 *   lists (`20261026T091403Z-<digest12>`, with or without `.json`);
 * - {@link joinDeclaredToIndex} gives every declared node a join verdict
 *   and lays the bound indexed nodes over the declared canvas, the way
 *   `--live` lays a live read over it (`sourceOverlayGraphs`).
 *
 * The join goes through each lexicon's own index match, its plugin's
 * `indexIdentity` (#4523, ./identity-match.ts). aws has one; a lexicon with
 * none gets `not-observed`, reason `unsupported-kind`, on every row, never a
 * guessed match. The verdicts:
 *
 * - `bound`: one indexed node carries the identity the declaration spells;
 * - `absent`: none does, and the index's coverage says it listed that type
 *   and location;
 * - `not-observed`: the index did not look (coverage `filtered`,
 *   `not-reached`, a read failure), the lexicon has no index match, or the
 *   index is of another substrate. Always with the reason and a detail;
 * - `no-binding`: the declaration does not spell an identity (a
 *   server-assigned id, a Ref), or the entity names no region and nothing
 *   matched;
 * - `ambiguous`: two or more indexed nodes carry the identity. None is bound.
 *
 * Indexed nodes no declared row binds stay out of a project's answer, as an
 * undeclared resource stays out of a `--live` one; with no project the index
 * is the whole graph ({@link indexOnlyGraph}).
 */
import { sourceOverlayGraphs, type GraphIR, type IRNode } from "../graph-ir";
import type { UnobservedEntity, UnobservedReason } from "../observation";
import { matchDeclaredToIndex, type DeclaredEntity, type IdentityMatch, type IndexIdentity } from "./identity-match";
import { indexVersionName, isIndexVersionName, validateIndexDocument, type IndexDocument } from "./index-document";
import type { SnapshotStore } from "./snapshot-store";

/** One index version, as a ref names it. */
export interface IndexRef {
  /** `stamp.scopeKey`: `<source path>/<scope path>`. */
  scopeKey: string;
  /** `latest`, or a version name with its `.json`. */
  version: string;
}

const SOURCE_PREFIXES = ["cloud/", "engine/", "chant/"];
const VERSION_ID = /^\d{8}T\d{6}Z-[0-9a-f]{12}(\.json)?$/;

const REF_HINT =
  "name an index version as <scope key>[@latest|@<version>], where the scope key is the index's stamp.scopeKey (cloud/aws/<account>/<scope digest>) and a version is a name the store lists, such as 20261026T091403Z-0123456789ab";

/** Parse `--index <ref>`, or say why it is not one. */
export function parseIndexRef(ref: string): IndexRef | { error: string; hint: string } {
  const text = ref.trim();
  if (text === "") return { error: "--index needs an index ref", hint: REF_HINT };
  let scopeKey = text;
  let version = "latest";
  const at = text.lastIndexOf("@");
  if (at >= 0) {
    scopeKey = text.slice(0, at);
    version = text.slice(at + 1);
    if (version !== "latest" && !VERSION_ID.test(version)) {
      return { error: `--index ${text}: "${version}" is not an index version`, hint: REF_HINT };
    }
  } else {
    const slash = text.lastIndexOf("/");
    const last = text.slice(slash + 1);
    if (slash > 0 && last.endsWith(".json") && VERSION_ID.test(last)) {
      scopeKey = text.slice(0, slash);
      version = last;
    }
  }
  if (version !== "latest" && !version.endsWith(".json")) version = `${version}.json`;
  if (!SOURCE_PREFIXES.some((p) => scopeKey.startsWith(p)) || scopeKey.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return { error: `--index ${text}: "${scopeKey}" is not an index scope key`, hint: REF_HINT };
  }
  return { scopeKey, version };
}

/** The ref as one string, version resolved: `<scope key>@<version name without .json>`. */
export function formatIndexRef(scopeKey: string, versionName: string): string {
  return `${scopeKey}@${versionName.replace(/\.json$/, "")}`;
}

export type IndexRead = { doc: IndexDocument; ref: IndexRef; version: string } | { error: string; hint?: string };

/**
 * Read the version a ref names. A stamp that disagrees with itself or with
 * the key it was read under is refused: the answer would be about another
 * scope than the one asked for.
 */
export async function readIndexRef(store: SnapshotStore, ref: IndexRef): Promise<IndexRead> {
  let doc: IndexDocument | null;
  try {
    doc = ref.version === "latest" ? await store.readIndexLatest(ref.scopeKey) : await store.readIndexAt(ref.scopeKey, ref.version);
  } catch (err) {
    return { error: `could not read the index ${ref.scopeKey} from ${store.where}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc) {
    return {
      error:
        ref.version === "latest"
          ? `no index version is recorded under ${ref.scopeKey} in ${store.where}`
          : `no index version ${ref.version.replace(/\.json$/, "")} is recorded under ${ref.scopeKey} in ${store.where}`,
      hint: "a scope key ends in its 12-hex scope digest, as the index's stamp.scopeKey spells it; the store is the project's `snapshots` store, or CHANT_SNAPSHOT_STORE and its companions",
    };
  }
  try {
    validateIndexDocument(doc);
  } catch (err) {
    return { error: `the index at ${ref.scopeKey} is not one chant can read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc.stamp.scopeKey !== ref.scopeKey) {
    return { error: `the index read under ${ref.scopeKey} is stamped ${doc.stamp.scopeKey}, so it is not the scope asked for` };
  }
  const version = indexVersionName(doc.stamp.observedAt, doc.stamp.digest);
  if (ref.version !== "latest" && isIndexVersionName(ref.version) && ref.version !== version) {
    return { error: `the index version ${ref.version} under ${ref.scopeKey} is stamped as ${version}, so it is not the version asked for` };
  }
  return { doc, ref, version };
}

interface JoinBase {
  /** The listed type and identifier the declaration spells, when it spells one. */
  listedType?: string;
  identifier?: string;
  location?: string;
}

/** One declared row's join verdict. */
export type IndexJoin =
  | (JoinBase & { verdict: "bound"; node: string; nativeId: string })
  | (JoinBase & { verdict: "absent" })
  | (JoinBase & { verdict: "not-observed"; reason: UnobservedReason; detail: string })
  | (JoinBase & { verdict: "no-binding"; detail: string })
  | (JoinBase & { verdict: "ambiguous"; candidates: string[]; detail: string });

export type IndexJoinVerdict = IndexJoin["verdict"];

/** Every verdict, in the order a summary lists them. */
export const INDEX_JOIN_VERDICTS: readonly IndexJoinVerdict[] = ["bound", "absent", "not-observed", "no-binding", "ambiguous"];

/** What the join needs of a lexicon: its name and its index match. */
export interface JoinLexicon {
  name: string;
  indexIdentity?: IndexIdentity;
}

export interface JoinOptions {
  /** The region of a declared node, from the stack it belongs to. */
  regionOf?: (id: string) => string | undefined;
}

export interface IndexJoinResult {
  /** The declared canvas with the bound indexed nodes laid over it. */
  ir: GraphIR;
  /** Every declared node's verdict, by node id. */
  joins: Record<string, IndexJoin>;
}

function fromMatch(m: IdentityMatch): IndexJoin {
  const base: JoinBase = {
    ...("listedType" in m && m.listedType !== undefined ? { listedType: m.listedType } : {}),
    ...("identifier" in m && m.identifier !== undefined ? { identifier: m.identifier } : {}),
    ...("location" in m && m.location !== undefined && m.location !== "" ? { location: m.location } : {}),
  };
  switch (m.verdict) {
    case "bound":
      return { ...base, verdict: "bound", node: m.node, nativeId: m.nativeId };
    case "absent":
      return { ...base, verdict: "absent" };
    case "refused":
      return { ...base, verdict: "ambiguous", candidates: m.candidates, detail: m.detail };
    case "not-observed":
      return m.reason === "no-binding"
        ? { ...base, verdict: "no-binding", detail: m.detail }
        : { ...base, verdict: "not-observed", reason: m.reason, detail: m.detail };
  }
}

/**
 * Join every declared node to an index version. Pure: the lexicons come in
 * as data. The canvas keeps every declared node and edge; a bound node takes
 * the indexed node's physical id, attributes and facts, as `--live` gives a
 * node its read's.
 */
export function joinDeclaredToIndex(
  declared: GraphIR,
  doc: IndexDocument,
  lexicons: readonly JoinLexicon[],
  options: JoinOptions = {},
): IndexJoinResult {
  const joins: Record<string, IndexJoin> = {};
  const scope = doc.stamp.scope;
  const byLexicon = new Map<string, IRNode[]>();
  for (const n of declared.nodes) (byLexicon.get(n.lexicon) ?? byLexicon.set(n.lexicon, []).get(n.lexicon)!).push(n);

  for (const [lexicon, nodes] of byLexicon) {
    const identity = lexicons.find((l) => l.name === lexicon)?.indexIdentity;
    if (!identity) {
      for (const n of nodes) {
        joins[n.id] = {
          verdict: "not-observed",
          reason: "unsupported-kind",
          detail: `the ${lexicon} lexicon has no index match, so a declared ${n.kind} is not joined to an indexed resource`,
        };
      }
      continue;
    }
    if (scope.kind !== "cloud") {
      for (const n of nodes) {
        joins[n.id] = {
          verdict: "not-observed",
          reason: "filtered",
          detail: `the index ${doc.stamp.scopeKey} is a ${scope.kind} source (${doc.stamp.source.name}); declared rows join only to a cloud read`,
        };
      }
      continue;
    }
    if (scope.substrate !== identity.substrate) {
      for (const n of nodes) {
        joins[n.id] = {
          verdict: "not-observed",
          reason: "filtered",
          detail: `the index ${doc.stamp.scopeKey} reads ${scope.substrate}, and a ${lexicon} entity lives in ${identity.substrate}`,
        };
      }
      continue;
    }
    const entities: DeclaredEntity[] = nodes.map((n) => {
      const region = options.regionOf?.(n.id);
      return { name: n.id, entityType: n.kind, props: (n.attrs ?? {}) as Record<string, unknown>, ...(region ? { region } : {}) };
    });
    const { matches } = matchDeclaredToIndex(entities, [doc], identity);
    for (const [id, m] of Object.entries(matches)) joins[id] = fromMatch(m);
  }

  // The bound indexed nodes, renamed to the declared node they bind, are the
  // observed side of the overlay. Nothing else of the index is.
  const indexed = new Map(doc.graph.nodes.map((n) => [n.id, n]));
  const live: IRNode[] = [];
  const unobserved: Record<string, UnobservedEntity> = {};
  for (const n of declared.nodes) {
    const j = joins[n.id];
    if (!j) continue;
    if (j.verdict === "bound") {
      const hit = indexed.get(j.node);
      if (hit) live.push({ ...hit, id: n.id, physicalId: hit.physicalId ?? j.nativeId });
    } else if (j.verdict === "not-observed" || j.verdict === "no-binding") {
      unobserved[n.id] = { type: n.kind, reason: j.verdict === "no-binding" ? "no-binding" : j.reason, detail: j.detail };
    }
  }
  live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let ir = sourceOverlayGraphs(declared, { ...declared, nodes: live, edges: [], exports: [] }, { unobserved });
  // An ambiguous row is neither pending nor unread: the index holds candidates
  // and chant will not pick one. Paint it as unknown, with no `_unobserved`.
  ir = {
    ...ir,
    nodes: ir.nodes.map((n) => (joins[n.id]?.verdict === "ambiguous" ? { ...n, attrs: { ...n.attrs, _status: "neutral" } } : n)),
  };
  return { ir, joins };
}

/**
 * The index alone, for a search with no project: every indexed node, each
 * with its native id as its physical id.
 */
export function indexOnlyGraph(doc: IndexDocument): GraphIR {
  return {
    ...doc.graph,
    nodes: doc.graph.nodes.map((n) => (n.physicalId === undefined && n.nativeId !== undefined ? { ...n, physicalId: n.nativeId } : n)),
    edges: doc.graph.edges ?? [],
  };
}

/** How many rows carry each verdict, for the provenance line. */
export function countJoins(joins: Record<string, IndexJoin>, ids: readonly string[]): Record<IndexJoinVerdict, number> {
  const out = Object.fromEntries(INDEX_JOIN_VERDICTS.map((v) => [v, 0])) as Record<IndexJoinVerdict, number>;
  for (const id of ids) {
    const j = joins[id];
    if (j) out[j.verdict] += 1;
  }
  return out;
}

/** A row's verdict where a physical id would go: `(absent)`, `(not observed: filtered)`, `(ambiguous: 2 candidates)`. */
export function joinCell(j: IndexJoin): string | undefined {
  switch (j.verdict) {
    case "bound":
      return undefined;
    case "absent":
      return "(absent)";
    case "not-observed":
      return `(not observed: ${j.reason})`;
    case "no-binding":
      return "(no-binding)";
    case "ambiguous":
      return `(ambiguous: ${j.candidates.length} candidates)`;
  }
}
