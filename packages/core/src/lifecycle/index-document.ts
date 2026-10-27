/**
 * An index document and where the index store keeps it (#4519, layout ruled
 * on INTENTIUS/behold#1025, 2026-10-26).
 *
 * An index is an observed graph: a chant snapshot, a cloud listing typed
 * through the lexicons (behold#1029, #4521), or a graph an engine prints
 * (choudoufu, plunge). Every index is derived, stamped, never read for a
 * decision and safe to lose. A document is a `GraphIR` inside a stamped
 * envelope, never a second graph format.
 *
 * This module is pure: types, the canonical scope digest and the store key.
 * ./snapshot-store.ts maps the keys onto a medium.
 *
 * Store key of an index version, relative to the store's `index` family:
 *
 *     <source path>/<scope path>/<observedAt>-<digest12>.json
 *
 * - source path: `cloud/<substrate>`, `engine/<engine>`, or `chant`;
 * - scope path: the scope's identity segments, then the first 12 hex of the
 *   scope digest: `<scopeId>/<scope digest>` for a cloud read,
 *   `<estate>/<scope digest>` or `<project>/<stack>/<scope digest>` for an
 *   engine, `<member>/<env>/<stack or ->/<lexicon>/<scope digest>` for chant.
 *   Each segment is percent-encoded, so `/` and `:` in a name survive a git
 *   path and an S3 key;
 * - version: the read's start as `yyyymmddThhmmssZ` and the first 12 hex of
 *   the document digest. A version is written once and never overwritten.
 *
 * Two reads with the same scope write under one scope path, and a read with
 * other regions, types or filters writes under another, so a reader refuses a
 * scope mismatch by comparing one string (`stamp.scopeKey`).
 */
import { createHash } from "node:crypto";
import type { GraphIR } from "../graph-ir";
import type { UnobservedReason } from "../observation";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that writes an index document to the store. */
export const INDEX_DOCUMENT_FLOOR = NEXT_RELEASE;

/** Who produced an index. */
export type IndexSourceKind = "cloud" | "engine" | "chant";

/** A direct cloud read (behold#1029). Lists are sorted and deduplicated by {@link canonicalScope}. */
export interface CloudIndexScope {
  kind: "cloud";
  substrate: "aws" | "azure" | "gcp" | "kubernetes";
  /** The account, subscription, project or cluster. */
  scopeId: string;
  /** Regions or locations, or `"*"` for every one. */
  locations: readonly string[] | "*";
  /** Listed types, or `"*"` for every one. */
  types: readonly string[] | "*";
  /** A tag or label filter, when the read had one. */
  tagFilter?: Readonly<Record<string, string>>;
}

/** A graph an engine printed (choudoufu, plunge). */
export interface EngineIndexScope {
  kind: "engine";
  engine: string;
  /** choudoufu's estate. */
  estate?: string;
  /** plunge's project and stack. */
  project?: string;
  stack?: string;
  /** The backend URL, with any credentials stripped before it reaches here. */
  backend?: string;
}

/** A chant source: a snapshot or `chant graph --format ir`. Today's snapshot key, unchanged. */
export interface ChantIndexScope {
  kind: "chant";
  /** `.` for a project outside a workspace. */
  member: string;
  env: string;
  stack?: string;
  lexicon: string;
}

export type IndexScope = CloudIndexScope | EngineIndexScope | ChantIndexScope;

export interface IndexSource {
  kind: IndexSourceKind;
  /** `behold-lister`, `choudoufu`, `plunge`, `chant`. */
  name: string;
  version?: string;
}

export interface IndexStamp {
  source: IndexSource;
  scope: IndexScope;
  /** The store path the scope maps to ({@link indexScopeKey}): a reader refuses a mismatch by comparing it. */
  scopeKey: string;
  /** When the read started, ISO UTC. */
  observedAt: string;
  /** When the last call returned, ISO UTC. */
  completedAt?: string;
  /** The source repository commit, when there is one. */
  commit?: string;
  /** sha256 hex of the canonical `graph` and `coverage` ({@link indexDocumentDigest}). */
  digest: string;
}

/** What a read looked at, per type and location. A node can be absent only where this says `listed`. */
export interface CoverageEntry {
  listedType: string;
  location: string;
  verdict: "listed" | UnobservedReason;
  detail?: string;
}

/** A type with no lister, a lexicon with no catalog, a disabled API. */
export interface IndexNote {
  kind: string;
  message: string;
  listedType?: string;
  location?: string;
}

/** One index version. */
export interface IndexDocument {
  index: "v1";
  stamp: IndexStamp;
  coverage: CoverageEntry[];
  graph: GraphIR;
  notes?: IndexNote[];
}

const sortUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * The scope with every list sorted and deduplicated and every absent field
 * left out, so two reads with the same flags give the same digest.
 */
export function canonicalScope(scope: IndexScope): IndexScope {
  switch (scope.kind) {
    case "cloud":
      return {
        kind: "cloud",
        substrate: scope.substrate,
        scopeId: scope.scopeId,
        locations: scope.locations === "*" ? "*" : sortUnique(scope.locations),
        types: scope.types === "*" ? "*" : sortUnique(scope.types),
        ...(scope.tagFilter && Object.keys(scope.tagFilter).length > 0
          ? { tagFilter: Object.fromEntries(Object.entries(scope.tagFilter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }
          : {}),
      };
    case "engine":
      return {
        kind: "engine",
        engine: scope.engine,
        ...(scope.estate !== undefined ? { estate: scope.estate } : {}),
        ...(scope.project !== undefined ? { project: scope.project } : {}),
        ...(scope.stack !== undefined ? { stack: scope.stack } : {}),
        ...(scope.backend !== undefined ? { backend: scope.backend } : {}),
      };
    case "chant":
      return {
        kind: "chant",
        member: scope.member,
        env: scope.env,
        ...(scope.stack !== undefined ? { stack: scope.stack } : {}),
        lexicon: scope.lexicon,
      };
  }
}

/** JSON with object keys sorted at every level. Arrays keep their order. */
export function canonicalIndexJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The first 12 hex of sha256 over the canonical scope. */
export function scopeDigest(scope: IndexScope): string {
  return sha256(canonicalIndexJson(canonicalScope(scope))).slice(0, 12);
}

/** sha256 hex over the canonical `graph` and `coverage`, so an unchanged re-read is cheap to recognise. */
export function indexDocumentDigest(doc: Pick<IndexDocument, "graph" | "coverage">): string {
  return sha256(canonicalIndexJson({ coverage: doc.coverage, graph: doc.graph }));
}

/** One path segment, percent-encoded so `/`, `:` and `%` in a name survive a git path and an S3 key. */
export function encodeIndexSegment(segment: string): string {
  if (segment === "") throw new Error("an index key segment is never empty");
  const encoded = encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // `.` and `..` are valid components to encodeURIComponent and meaningful to a filesystem.
  return encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
}

/** `cloud/<substrate>`, `engine/<engine>` or `chant`. */
export function indexSourcePath(scope: IndexScope): string {
  switch (scope.kind) {
    case "cloud":
      return `cloud/${encodeIndexSegment(scope.substrate)}`;
    case "engine":
      return `engine/${encodeIndexSegment(scope.engine)}`;
    case "chant":
      return "chant";
  }
}

/** The scope's identity segments, then its digest. */
export function indexScopePath(scope: IndexScope): string {
  const digest = scopeDigest(scope);
  let segments: string[];
  switch (scope.kind) {
    case "cloud":
      segments = [scope.scopeId];
      break;
    case "engine":
      segments = scope.estate !== undefined ? [scope.estate] : [scope.project ?? "-", scope.stack ?? "-"];
      break;
    case "chant":
      segments = [scope.member, scope.env, scope.stack ?? "-", scope.lexicon];
      break;
  }
  return [...segments.map(encodeIndexSegment), digest].join("/");
}

/** `<source path>/<scope path>`: what `stamp.scopeKey` holds and what the store lists under. */
export function indexScopeKey(scope: IndexScope): string {
  return `${indexSourcePath(scope)}/${indexScopePath(scope)}`;
}

/** `2026-10-26T09:14:03.120Z` as `20261026T091403Z`. */
export function compactObservedAt(observedAt: string): string {
  const t = new Date(observedAt);
  if (Number.isNaN(t.getTime())) throw new Error(`observedAt "${observedAt}" is not a time`);
  return t.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

/** `<observedAt>-<digest12>.json`. Names sort in time order. */
export function indexVersionName(observedAt: string, digest: string): string {
  const hex = digest.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{12,}$/.test(hex)) throw new Error(`digest "${digest}" is not sha256 hex`);
  return `${compactObservedAt(observedAt)}-${hex.slice(0, 12)}.json`;
}

/** Whether a name in a scope path is a version (and not `scope.json`). */
export function isIndexVersionName(name: string): boolean {
  return /^\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(name);
}

/** The file beside the versions that holds the scope in full, so a person or `list` can read what a digest means. */
export const INDEX_SCOPE_FILE = "scope.json";

/**
 * Refuse a document whose stamp disagrees with itself: a `scopeKey` that is
 * not its scope's, or a source kind that is not its scope's kind. The store
 * writes only a document that passes, so a path always means its scope.
 */
export function validateIndexDocument(doc: IndexDocument): void {
  if (doc.index !== "v1") throw new Error(`index document version "${String(doc.index)}" is not v1`);
  const { stamp } = doc;
  if (stamp.source.kind !== stamp.scope.kind) {
    throw new Error(`index stamp source kind "${stamp.source.kind}" does not match its scope kind "${stamp.scope.kind}"`);
  }
  const expected = indexScopeKey(stamp.scope);
  if (stamp.scopeKey !== expected) {
    throw new Error(`index stamp scopeKey "${stamp.scopeKey}" is not its scope's key "${expected}"`);
  }
  indexVersionName(stamp.observedAt, stamp.digest);
}
