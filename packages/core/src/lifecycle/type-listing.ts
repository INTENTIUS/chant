/**
 * Typed nodes for indexed resources (#4521, tier 1 of INTENTIUS/behold#1025).
 *
 * behold#1029's cloud lister reads one account, subscription, project or
 * cluster through that cloud's inventory API and returns a
 * {@link ListingResult}. {@link typeListing} turns it into an
 * {@link IndexDocument}: each listed object becomes an `IRNode` whose `kind`
 * is the lexicon kind that describes it, with its properties normalized by
 * that lexicon's own deep-observe hooks, so an indexed tree has the shape an
 * observed one has and the capability catalog (#4375) applies to it.
 *
 * Pure: no I/O and no clock. The lexicons come in as data (each plugin's
 * `listedTypes` and `deepNormalizationHooks`), so behold passes the plugins
 * it already loads and a test passes a table.
 *
 * Rules:
 * - a listed type no lexicon maps stays a node of unknown kind: `kind` is
 *   the listed type, `lexicon` the substrate, `unmappedKind: true`. It is
 *   never dropped, and a note names each such type once;
 * - secret-bearing values are masked with the one list the snapshot path
 *   uses (`isSensitiveKey`, ../sensitive-key.ts). The lister masked already;
 *   masking again here means no listing reaches the index unmasked;
 * - a node id is the path-style id ruled on behold#1025 (Q2):
 *   `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>`.
 *
 * Edges are #4522's (./derive-edges.ts); this module leaves `edges` empty.
 */
import type { DeepNormalizationHooks } from "../deep-observation";
import { MASKED, isSensitiveKey, normalizeDeepProperties } from "../deep-observation";
import type { EngineFacts } from "../engine-facts";
import type { GraphIR, IRNode } from "../graph-ir";
import {
  canonicalScope,
  indexDocumentDigest,
  indexScopeKey,
  type CloudIndexScope,
  type CoverageEntry,
  type IndexDocument,
  type IndexNote,
} from "./index-document";

/** The four substrates the lister reads, one per run (behold#1025 Q6). */
export type ListingSubstrate = CloudIndexScope["substrate"];

/** One run's scope, as the lister names it. `"*"` means every location or type. */
export interface CloudScope {
  substrate: ListingSubstrate;
  scopeId: string;
  locations: readonly string[] | "*";
  types: readonly string[] | "*";
  tagFilter?: Readonly<Record<string, string>>;
}

/** A cloud id, kinds as #4520 ruled them (`EngineFacts.cloudIds`). */
export interface ListedCloudId {
  kind: "import-id" | "arn" | "provider-id" | "self-link" | "k8s-uid";
  value: string;
}

/** The facts a cloud listing can supply: markers read off tags, cloud ids, when it was read. */
export interface ListedFacts {
  markers?: EngineFacts["markers"];
  cloudIds: ListedCloudId[];
  observedAt: string;
}

/** One listed object (behold#1025 `ListedResource`). */
export interface ListedResource {
  /** The path-style id; recomputed by {@link listedNodeId}, so a listing may leave it out. */
  id?: string;
  listedType: string;
  location: string;
  nativeId: string;
  cloudIds: ListedCloudId[];
  tags: Record<string, string>;
  /** As returned, unnormalized, already masked by the lister. */
  properties: Record<string, unknown>;
  observedAt: string;
  facts?: ListedFacts;
}

/** A lister note: a type with no lister, a disabled API, a tag filter. */
export interface ListingNote {
  code: string;
  message: string;
  listedType?: string;
  location?: string;
  command?: string;
}

/** The lister's whole output for one run (behold#1025 `ListingResult`, behold#1029). */
export interface ListingResult {
  listing: "v1";
  source?: { name: string; version?: string };
  scope: CloudScope;
  startedAt: string;
  completedAt: string;
  resources: ListedResource[];
  coverage: CoverageEntry[];
  notes: ListingNote[];
}

/**
 * How a lexicon reads one substrate's listed types (a plugin's
 * `listedTypes`). Data plus two pure functions.
 */
export interface ListedTypeMapping {
  substrate: ListingSubstrate;
  /** The lexicon kind for a listed type, or undefined when the lexicon has none. */
  kindFor(listedType: string): string | undefined;
  /**
   * The listed properties reshaped into the tree this lexicon's deep reader
   * returns, before the hooks run: Azure flattens `properties.*` beside
   * `location` and `sku`, Kubernetes drops `apiVersion` and `kind`. Absent
   * means the listing's shape already is that tree (Cloud Control's
   * CloudFormation model).
   */
  observedTree?(properties: Record<string, unknown>, context: { listedType: string; kind: string }): Record<string, unknown>;
}

/** What {@link typeListing} needs from a lexicon. A `LexiconPlugin` is one. */
export interface ListingLexicon {
  name: string;
  listedTypes?: ListedTypeMapping;
  deepNormalizationHooks?: DeepNormalizationHooks;
}

function escapeSegment(s: string): string {
  return s.replace(/%/g, "%25").replace(/\//g, "%2F");
}

/**
 * `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>` (behold#1025
 * Q2), exactly as behold's lister writes it (src/cloud-lister/ids.ts): `%`
 * and `/` are escaped in the first four parts, and the native id is last and
 * unescaped, so everything after the fourth `/` is it.
 */
export function listedNodeId(parts: { substrate: string; scopeId: string; location: string; listedType: string; nativeId: string }): string {
  return [
    escapeSegment(parts.substrate),
    escapeSegment(parts.scopeId),
    escapeSegment(parts.location),
    escapeSegment(parts.listedType),
    parts.nativeId,
  ].join("/");
}

/** The lexicon (and kind) for one listed type: the first mapping, by lexicon name, that answers. */
export function resolveListedKind(
  substrate: ListingSubstrate,
  listedType: string,
  lexicons: readonly ListingLexicon[],
): { lexicon: ListingLexicon; kind: string } | undefined {
  for (const lexicon of lexicons) {
    const mapping = lexicon.listedTypes;
    if (!mapping || mapping.substrate !== substrate) continue;
    const kind = mapping.kindFor(listedType);
    if (kind !== undefined) return { lexicon, kind };
  }
  return undefined;
}

function maskTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(tags).sort()) out[k] = isSensitiveKey(k) ? MASKED : tags[k];
  return out;
}

const byName = (a: ListingLexicon, b: ListingLexicon) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** One listed object as a typed (or unknown-kind) node. */
export function typeListedResource(
  scope: CloudScope,
  resource: ListedResource,
  lexicons: readonly ListingLexicon[],
): IRNode {
  const sorted = [...lexicons].sort(byName);
  const resolved = resolveListedKind(scope.substrate, resource.listedType, sorted);
  const id = listedNodeId({
    substrate: scope.substrate,
    scopeId: scope.scopeId,
    location: resource.location,
    listedType: resource.listedType,
    nativeId: resource.nativeId,
  });
  let kind: string;
  let lexicon: string;
  let attrs: Record<string, unknown>;
  if (resolved) {
    kind = resolved.kind;
    lexicon = resolved.lexicon.name;
    const reshape = resolved.lexicon.listedTypes?.observedTree;
    const tree = reshape ? reshape(resource.properties, { listedType: resource.listedType, kind }) : resource.properties;
    attrs = normalizeDeepProperties(tree, { entityType: kind, side: "live", hooks: resolved.lexicon.deepNormalizationHooks });
  } else {
    kind = resource.listedType;
    lexicon = scope.substrate;
    // No lexicon, so no hooks: the listing's properties as returned, key-sorted and masked.
    attrs = normalizeDeepProperties(resource.properties, { entityType: resource.listedType, side: "live" });
  }
  const cloudIds = resource.cloudIds.length > 0 ? resource.cloudIds : resource.facts?.cloudIds ?? [];
  const facts: EngineFacts = {
    ...(resource.facts?.markers ? { markers: resource.facts.markers } : {}),
    ...(cloudIds.length > 0 ? { cloudIds: cloudIds.map((c) => ({ kind: c.kind, value: c.value })) } : {}),
    observedAt: resource.facts?.observedAt ?? resource.observedAt,
  };
  return {
    id,
    kind,
    lexicon,
    attrs,
    physicalId: resource.nativeId,
    facts,
    listedType: resource.listedType,
    location: resource.location,
    nativeId: resource.nativeId,
    tags: maskTags(resource.tags ?? {}),
    ...(resolved ? {} : { unmappedKind: true }),
  };
}

/** The listing's scope as the index stamp's cloud scope. */
export function listingIndexScope(scope: CloudScope): CloudIndexScope {
  return canonicalScope({
    kind: "cloud",
    substrate: scope.substrate,
    scopeId: scope.scopeId,
    locations: scope.locations,
    types: scope.types,
    ...(scope.tagFilter ? { tagFilter: scope.tagFilter } : {}),
  }) as CloudIndexScope;
}

/** Every listed object as a node, sorted by id. */
export function typeListingNodes(listing: ListingResult, lexicons: readonly ListingLexicon[]): IRNode[] {
  const nodes = listing.resources.map((r) => typeListedResource(listing.scope, r, lexicons));
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return nodes;
}

const compareNotes = (a: IndexNote, b: IndexNote): number => {
  const ka = `${a.kind}\u0000${a.listedType ?? ""}\u0000${a.location ?? ""}\u0000${a.message}`;
  const kb = `${b.kind}\u0000${b.listedType ?? ""}\u0000${b.location ?? ""}\u0000${b.message}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * The listing as one index version (behold#1025 schema). `graph.edges` is
 * empty; chant#4522's `deriveEdges` fills it. Coverage passes through as the
 * lister wrote it, wildcards included. The lister's notes keep their code as
 * `kind`, and each unmapped listed type gets one `unmapped-type` note.
 */
export function typeListing(listing: ListingResult, lexicons: readonly ListingLexicon[]): IndexDocument {
  const nodes = typeListingNodes(listing, lexicons);
  const graph: GraphIR = {
    version: 1,
    nodes,
    edges: [],
    groups: { byLexicon: groupByLexicon(nodes) },
  };
  const coverage = [...listing.coverage].map((c) => ({ ...c }));
  const notes: IndexNote[] = listing.notes.map((n) => ({
    kind: n.code,
    message: n.message,
    ...(n.listedType !== undefined ? { listedType: n.listedType } : {}),
    ...(n.location !== undefined ? { location: n.location } : {}),
    ...(n.command !== undefined ? { command: n.command } : {}),
  }));
  const unmapped = [...new Set(nodes.filter((n) => n.unmappedKind).map((n) => n.listedType!))].sort();
  for (const t of unmapped) {
    notes.push({
      kind: "unmapped-type",
      listedType: t,
      message: `no lexicon kind maps the listed type ${t}; its objects are kept as nodes of unknown kind, with the listing's properties masked`,
    });
  }
  notes.sort(compareNotes);
  return assembleIndexDocument(listing, graph, coverage, notes);
}

/** Stamp a graph, coverage and notes read from `listing` as one index version. */
export function assembleIndexDocument(
  listing: ListingResult,
  graph: GraphIR,
  coverage: CoverageEntry[],
  notes: IndexNote[],
): IndexDocument {
  const scope = listingIndexScope(listing.scope);
  return {
    index: "v1",
    stamp: {
      source: { kind: "cloud", name: listing.source?.name ?? "behold-lister", ...(listing.source?.version ? { version: listing.source.version } : {}) },
      scope,
      scopeKey: indexScopeKey(scope),
      observedAt: listing.startedAt,
      completedAt: listing.completedAt,
      digest: indexDocumentDigest({ graph, coverage }),
    },
    coverage,
    graph,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function groupByLexicon(nodes: readonly IRNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of nodes) (out[n.lexicon] ??= []).push(n.id);
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k].sort()]));
}
