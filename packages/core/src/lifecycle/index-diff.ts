/**
 * What changed between two versions of one index scope (#4533, moved from
 * INTENTIUS/behold#1028's src/graph-db/index-diff.ts under the ruling that
 * behold is a control plane and every model lives in chant,
 * INTENTIUS/behold#1024).
 *
 * A pure function over two index versions (./index-document.ts): nodes added
 * and removed, properties changed, edges added and removed. It reads nothing
 * and writes nothing; {@link readIndexVersionRef} and
 * {@link diffIndexVersionRefs} load the two versions through a
 * {@link SnapshotStore}, so every store kind (git ref, local, s3) diffs the
 * same way.
 *
 * The lifecycle deep diff (./deep-diff.ts) compares a declared tree with a
 * live one, and a live path no declaration claims is "unclaimed" there rather
 * than a change. Two index versions are both observed, so this comparison is
 * symmetric.
 *
 * Rules:
 *
 *  - One scope per diff. Two versions whose `stamp.scopeKey` differ are
 *    refused by name with {@link IndexScopeMismatch}: a node missing from one
 *    could just be out of its scope.
 *  - A node is removed only when the later read listed its (type, location).
 *    Otherwise it is `not-observed` in that read, with the coverage verdict
 *    that says why. The other way round, a node is added only when the earlier
 *    read listed its (type, location). Coverage is looked up with
 *    {@link indexCoverageFor}, where `"*"` matches every type or location.
 *    {@link indexAbsence} is that rule on its own, for #4526's drift from an
 *    index, so both read "absent" the same way.
 *  - An edge is removed (or added) only when both its ends were observed in
 *    the read that lacks it; otherwise it is `not-observed`.
 *  - Properties: `kind`, and each leaf path of `attrs` (arrays compare as
 *    whole values). `tags` is compared only for a node whose `attrs` show no
 *    change, because a lister's tags are a projection of the listed
 *    properties: one tag edit is one changed property, not two. `facts` is
 *    never compared (its `observedAt` moves on every read).
 *  - Two versions with the same `stamp.digest` hold the same graph and
 *    coverage: the diff is `unchanged` and nothing is walked.
 */
import { NEXT_RELEASE } from "../release-floors";
import { indexCoverageFor, isIndexVersionName, type CoverageEntry, type IndexDocument } from "./index-document";
import type { SnapshotStore } from "./snapshot-store";

/** The first chant that exports the index diff and `chant index diff`. */
export const INDEX_DIFF_FLOOR = NEXT_RELEASE;

/**
 * The words a comparison against an index uses (#4533, shared with #4526).
 * `not-observed` is the drift record's word for the same thing
 * (../drift-record.ts `DriftStatus`): the read could not say, and the
 * coverage verdict says why.
 */
export type IndexChangeKind = "added" | "removed" | "changed" | "not-observed";
export const INDEX_CHANGE_KINDS: readonly IndexChangeKind[] = ["added", "removed", "changed", "not-observed"];

/** A coverage entry as the diff reads it: chant's `CoverageEntry`, or the same shape with any verdict string. */
export interface IndexDiffCoverageEntry {
  listedType: string;
  location: string;
  verdict: CoverageEntry["verdict"] | (string & {});
  detail?: string;
}

/** The parts of an index node the diff reads. An `IRNode` is one. */
export interface IndexDiffNode {
  id: string;
  kind: string;
  lexicon?: string;
  attrs?: Record<string, unknown>;
  tags?: Record<string, string>;
  listedType?: string;
  location?: string;
  nativeId?: string;
  physicalId?: string;
}

/** The parts of an index edge the diff reads. An `IREdge` is one. */
export interface IndexDiffEdge {
  from: string;
  to: string;
  kind?: string;
  viaAttr?: string;
  relation?: string;
  origin?: string;
  rule?: string;
}

/** The parts of an index version the diff reads. An {@link IndexDocument} is one. */
export interface IndexDiffDocument {
  index: string;
  stamp: { scopeKey: string; observedAt: string; completedAt?: string; digest: string; source?: { kind: string; name: string; version?: string } };
  coverage: readonly IndexDiffCoverageEntry[];
  graph: { nodes: readonly IndexDiffNode[]; edges: readonly IndexDiffEdge[] };
}

/** Two versions of different scopes. Refused by name, never diffed. */
export class IndexScopeMismatch extends Error {
  readonly code = "index-scope-mismatch";
  constructor(
    readonly fromScopeKey: string,
    readonly toScopeKey: string,
  ) {
    super(
      `refused: the two index versions have different scopes (${fromScopeKey} and ${toScopeKey}), and a node missing from one could just be out of its scope. Diff two versions of one scope.`,
    );
    this.name = "IndexScopeMismatch";
  }
}

/** A document that is not an index version, or a reference no store holds. */
export class NotAnIndexVersion extends Error {
  readonly code = "not-an-index-version";
  constructor(message: string) {
    super(message);
    this.name = "NotAnIndexVersion";
  }
}

export interface IndexDiffStamp {
  scopeKey: string;
  observedAt: string;
  completedAt?: string;
  digest: string;
  source?: { kind: string; name: string; version?: string };
  /** The version name, when the caller knows it. */
  version?: string;
}

export interface IndexNodeRef {
  key: string;
  kind: string;
  listedType: string;
  location: string;
}

export interface IndexPropertyChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface IndexNodeChanged extends IndexNodeRef {
  properties: IndexPropertyChange[];
}

/** A node one read has and the other did not observe. `side` names the read that did not observe it. */
export interface IndexNodeNotObserved extends IndexNodeRef {
  side: "from" | "to";
  /** The coverage verdict for its (type, location) in that read, or `not-in-coverage`. */
  verdict: string;
  detail?: string;
}

export interface IndexEdgeRef {
  from: string;
  to: string;
  kind: string;
  viaAttr?: string;
  relation: string;
  origin?: string;
  rule?: string;
}

export interface IndexEdgeNotObserved extends IndexEdgeRef {
  side: "from" | "to";
  /** The end whose (type, location) was not observed in that read. */
  unobservedEnd: string;
  verdict: string;
}

export interface IndexDiff {
  diff: "v1";
  scopeKey: string;
  from: IndexDiffStamp;
  to: IndexDiffStamp;
  /** Same digest: same graph and coverage. */
  unchanged: boolean;
  nodes: {
    added: IndexNodeRef[];
    removed: IndexNodeRef[];
    changed: IndexNodeChanged[];
    notObserved: IndexNodeNotObserved[];
  };
  edges: {
    added: IndexEdgeRef[];
    removed: IndexEdgeRef[];
    notObserved: IndexEdgeNotObserved[];
  };
  /** (type, location) pairs whose verdict moved between the reads. */
  coverage: Array<{ listedType: string; location: string; before?: string; after?: string }>;
  counts: { added: number; removed: number; changed: number; properties: number; notObserved: number; edgesAdded: number; edgesRemoved: number; edgesNotObserved: number };
}

export interface IndexDiffOptions {
  /** Version names, for the stamps. */
  fromVersion?: string;
  toVersion?: string;
}

/** The inverse of index-document.ts encodeIndexSegment; a segment that is not percent-encoded comes back as it is. */
function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A node's (type, location): its own `listedType` and `location` (#4521
 * writes both), else the path-style id's fourth and third segments
 * (behold#1025 Q2, `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>`),
 * else its kind at every location.
 */
export function indexNodeTypeAndLocation(n: IndexDiffNode): { listedType: string; location: string } {
  if (n.listedType && n.location) return { listedType: n.listedType, location: n.location };
  const parts = n.id.split("/");
  if (parts.length >= 5) return { listedType: n.listedType ?? decodeSegment(parts[3]!), location: n.location ?? decodeSegment(parts[2]!) };
  return { listedType: n.listedType ?? n.kind, location: n.location ?? "*" };
}

/** What an index's coverage says about a (type, location) that holds no node. */
export type IndexAbsence = { kind: "removed" } | { kind: "not-observed"; verdict: string; detail?: string };

/**
 * The rule for an absent node (#4533, shared with #4526): absent counts as
 * gone (`removed`) only where the read's coverage says `listed` for the
 * node's (type, location); anywhere else it is `not-observed`, with the
 * verdict, or `not-in-coverage` when no entry speaks for it.
 */
export function indexAbsence(coverage: readonly IndexDiffCoverageEntry[], listedType: string, location: string): IndexAbsence {
  const e = indexCoverageFor(coverage, listedType, location);
  if (e?.verdict === "listed") return { kind: "removed" };
  return e ? { kind: "not-observed", verdict: e.verdict, ...(e.detail ? { detail: e.detail } : {}) } : { kind: "not-observed", verdict: "not-in-coverage" };
}

function stampOf(doc: IndexDiffDocument, version?: string): IndexDiffStamp {
  const s = doc.stamp;
  return {
    scopeKey: s.scopeKey,
    observedAt: s.observedAt,
    ...(s.completedAt ? { completedAt: s.completedAt } : {}),
    digest: s.digest,
    ...(s.source ? { source: s.source } : {}),
    ...(version ? { version } : {}),
  };
}

function check(doc: IndexDiffDocument, which: string): void {
  if (!doc || doc.index !== "v1" || typeof doc.stamp?.scopeKey !== "string" || !Array.isArray(doc.graph?.nodes)) {
    throw new NotAnIndexVersion(`the ${which} document is not an index version (index: "v1" with a stamp and a graph)`);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON with keys sorted, so equal values compare equal. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (isPlain(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? "undefined";
}

/** Leaf paths of an object; arrays and scalars are leaves. */
function leaves(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlain(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, v);
  }
}

function changedPaths(before: unknown, after: unknown, root: string): IndexPropertyChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  leaves(before ?? {}, root, a);
  leaves(after ?? {}, root, b);
  const out: IndexPropertyChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    if (canon(x) === canon(y)) continue;
    out.push({ path, ...(a.has(path) ? { before: x } : {}), ...(b.has(path) ? { after: y } : {}) });
  }
  return out;
}

/** The property changes of one node between two reads. */
export function indexNodePropertyChanges(before: IndexDiffNode, after: IndexDiffNode): IndexPropertyChange[] {
  const out: IndexPropertyChange[] = [];
  if (before.kind !== after.kind) out.push({ path: "kind", before: before.kind, after: after.kind });
  const attrs = changedPaths(before.attrs, after.attrs, "attrs");
  out.push(...attrs);
  if (attrs.length === 0) out.push(...changedPaths(before.tags, after.tags, "tags"));
  return out;
}

function edgeKey(e: IndexDiffEdge): string {
  return [e.from, e.to, e.kind ?? "", e.viaAttr ?? "", e.relation ?? "reference"].join("\u0000");
}

function edgeRef(e: IndexDiffEdge): IndexEdgeRef {
  return {
    from: e.from,
    to: e.to,
    kind: e.kind ?? "",
    ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}),
    relation: e.relation ?? "reference",
    ...(e.origin ? { origin: e.origin } : {}),
    ...(e.rule ? { rule: e.rule } : {}),
  };
}

const refOf = (n: IndexDiffNode): IndexNodeRef => ({ key: n.id, kind: n.kind, ...indexNodeTypeAndLocation(n) });
const byKey = <T>([a]: [string, T], [b]: [string, T]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What changed from `from` to `to`, two versions of one index scope.
 * Throws {@link IndexScopeMismatch} when their scope keys differ, and
 * {@link NotAnIndexVersion} for a document of another shape.
 */
export function diffIndexVersions(from: IndexDiffDocument, to: IndexDiffDocument, o: IndexDiffOptions = {}): IndexDiff {
  check(from, "first");
  check(to, "second");
  if (from.stamp.scopeKey !== to.stamp.scopeKey) throw new IndexScopeMismatch(from.stamp.scopeKey, to.stamp.scopeKey);
  const out: IndexDiff = {
    diff: "v1",
    scopeKey: from.stamp.scopeKey,
    from: stampOf(from, o.fromVersion),
    to: stampOf(to, o.toVersion),
    unchanged: false,
    nodes: { added: [], removed: [], changed: [], notObserved: [] },
    edges: { added: [], removed: [], notObserved: [] },
    coverage: [],
    counts: { added: 0, removed: 0, changed: 0, properties: 0, notObserved: 0, edgesAdded: 0, edgesRemoved: 0, edgesNotObserved: 0 },
  };
  if (from.stamp.digest && from.stamp.digest === to.stamp.digest) {
    out.unchanged = true;
    return out;
  }

  const absence = (doc: IndexDiffDocument, n: IndexDiffNode): IndexAbsence => {
    const { listedType, location } = indexNodeTypeAndLocation(n);
    return indexAbsence(doc.coverage, listedType, location);
  };
  const unobserved = (n: IndexDiffNode, a: Extract<IndexAbsence, { kind: "not-observed" }>, side: "from" | "to"): IndexNodeNotObserved => ({
    ...refOf(n),
    side,
    verdict: a.verdict,
    ...(a.detail ? { detail: a.detail } : {}),
  });

  const before = new Map(from.graph.nodes.map((n) => [n.id, n]));
  const after = new Map(to.graph.nodes.map((n) => [n.id, n]));
  for (const [id, n] of [...before].sort(byKey)) {
    const m = after.get(id);
    if (m) {
      const properties = indexNodePropertyChanges(n, m);
      if (properties.length > 0) out.nodes.changed.push({ ...refOf(m), properties });
      continue;
    }
    const a = absence(to, n);
    if (a.kind === "removed") out.nodes.removed.push(refOf(n));
    else out.nodes.notObserved.push(unobserved(n, a, "to"));
  }
  for (const [id, n] of [...after].sort(byKey)) {
    if (before.has(id)) continue;
    const a = absence(from, n);
    if (a.kind === "removed") out.nodes.added.push(refOf(n));
    else out.nodes.notObserved.push(unobserved(n, a, "from"));
  }

  // An edge's ends are looked up in either read: a removed edge's ends may be gone from `to`.
  const nodeFor = (id: string): IndexDiffNode => after.get(id) ?? before.get(id) ?? { id, kind: "" };
  const edgesIn = (doc: IndexDiffDocument) => new Map(doc.graph.edges.map((e) => [edgeKey(e), e]));
  const ea = edgesIn(from);
  const eb = edgesIn(to);
  const classify = (e: IndexDiffEdge, lacking: IndexDiffDocument, side: "from" | "to", into: IndexEdgeRef[]) => {
    for (const end of [e.from, e.to]) {
      const a = absence(lacking, nodeFor(end));
      if (a.kind === "not-observed") {
        out.edges.notObserved.push({ ...edgeRef(e), side, unobservedEnd: end, verdict: a.verdict });
        return;
      }
    }
    into.push(edgeRef(e));
  };
  for (const [k, e] of [...ea].sort(byKey)) if (!eb.has(k)) classify(e, to, "to", out.edges.removed);
  for (const [k, e] of [...eb].sort(byKey)) if (!ea.has(k)) classify(e, from, "from", out.edges.added);

  const cov = new Map<string, { listedType: string; location: string; before?: string; after?: string }>();
  for (const e of from.coverage) cov.set(`${e.listedType}\u0000${e.location}`, { listedType: e.listedType, location: e.location, before: e.verdict });
  for (const e of to.coverage) {
    const k = `${e.listedType}\u0000${e.location}`;
    cov.set(k, { ...(cov.get(k) ?? { listedType: e.listedType, location: e.location }), after: e.verdict });
  }
  out.coverage = [...cov.values()]
    .filter((c) => c.before !== c.after)
    .sort((a, b) => (a.listedType + "\u0000" + a.location < b.listedType + "\u0000" + b.location ? -1 : 1));

  out.counts = {
    added: out.nodes.added.length,
    removed: out.nodes.removed.length,
    changed: out.nodes.changed.length,
    properties: out.nodes.changed.reduce((s, c) => s + c.properties.length, 0),
    notObserved: out.nodes.notObserved.length,
    edgesAdded: out.edges.added.length,
    edgesRemoved: out.edges.removed.length,
    edgesNotObserved: out.edges.notObserved.length,
  };
  return out;
}

// ── Reading versions through the store (#4519) ──────────────────────

/** A parsed version reference: `<scopeKey>/<version>`, or `<scopeKey>` alone for its latest. */
export interface IndexVersionRef {
  scopeKey: string;
  /** Absent: the scope's latest version. */
  version?: string;
}

/**
 * Parse `<scopeKey>/<version>` or `<scopeKey>`. A bare version name (no
 * scope) takes `inScope`'s scope, so `--against <version>` can name another
 * version of the first argument's scope.
 */
export function parseIndexVersionRef(ref: string, inScope?: string): IndexVersionRef {
  const trimmed = ref.replace(/^\/+|\/+$/g, "");
  const slash = trimmed.lastIndexOf("/");
  const last = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  if (isIndexVersionName(last)) {
    if (slash >= 0) return { scopeKey: trimmed.slice(0, slash), version: last };
    if (!inScope) throw new NotAnIndexVersion(`"${ref}" is a version name with no scope: name it as <scopeKey>/${last}`);
    return { scopeKey: inScope, version: last };
  }
  if (!trimmed) throw new NotAnIndexVersion("an empty index version reference");
  return { scopeKey: trimmed };
}

/** One version read from a store, with the name it is stored under. */
export interface StoredIndexVersion {
  scopeKey: string;
  version: string;
  doc: IndexDocument;
}

/** Read one version (or a scope's latest) through the store. Throws {@link NotAnIndexVersion} when the store has none. */
export async function readIndexVersionRef(store: Pick<SnapshotStore, "kind" | "listIndex" | "readIndexAt">, ref: IndexVersionRef): Promise<StoredIndexVersion> {
  const version = ref.version ?? (await store.listIndex(ref.scopeKey)).pop();
  if (!version) throw new NotAnIndexVersion(`the ${store.kind} store holds no index version under ${ref.scopeKey}`);
  const doc = await store.readIndexAt(ref.scopeKey, version);
  if (!doc) throw new NotAnIndexVersion(`the ${store.kind} store holds no index version ${ref.scopeKey}/${version}`);
  return { scopeKey: ref.scopeKey, version, doc };
}

/**
 * Diff two stored versions. `to` absent: `from` names a scope (or a version
 * in one), and the diff is the scope's last two versions, or the version
 * before `from` against `from`. Two references under different scope paths
 * are refused before either is read.
 */
export async function diffIndexVersionRefs(store: Pick<SnapshotStore, "kind" | "listIndex" | "readIndexAt">, from: IndexVersionRef, to?: IndexVersionRef): Promise<IndexDiff> {
  let a = from;
  let b = to;
  if (!b) {
    const versions = await store.listIndex(from.scopeKey);
    const at = from.version ? versions.indexOf(from.version) : versions.length - 1;
    if (at < 1) throw new NotAnIndexVersion(`the ${store.kind} store holds no version before ${from.version ?? "the latest"} under ${from.scopeKey}: name two versions`);
    a = { scopeKey: from.scopeKey, version: versions[at - 1] };
    b = { scopeKey: from.scopeKey, version: versions[at] };
  }
  if (a.scopeKey !== b.scopeKey) throw new IndexScopeMismatch(a.scopeKey, b.scopeKey);
  const x = await readIndexVersionRef(store, a);
  const y = await readIndexVersionRef(store, b);
  return diffIndexVersions(x.doc, y.doc, { fromVersion: x.version, toVersion: y.version });
}
