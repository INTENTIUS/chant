/**
 * Engine facts on graph nodes, and the engine graph document (#4527, designed
 * on #4520 and ruled there 2026-10-26).
 *
 * An ownership engine (choudoufu, plunge) prints one JSON document per read:
 * a `GraphIR` at version 1 whose `meta.engineGraph` says which engine read
 * what, and whose nodes carry {@link EngineFacts} under `facts`. behold#1027
 * loads it as it is; chant's terraform and pulumi lexicons read the same
 * document onto `ResourceMetadata.facts`, which `buildLiveGraphIr` copies to
 * the node.
 *
 * Facts are for people and for readers that show the graph. Nothing in chant
 * decides from them: no change set, lifecycle step or Op imports this module
 * (./engine-facts.guard.test.ts), and `IRNode.ownership` keeps its own meaning.
 *
 * The JSON Schema in ./graph-schema/graph.schema.json is generated from these
 * types and ./lifecycle/index-document.ts (`npm run generate:graph-schema`).
 */
import type { GraphIR } from "./graph-ir";
import { NEXT_RELEASE } from "./release-floors";

/** The format of {@link EngineGraphMeta}. Moves only for a change a reader could not ignore. */
export const ENGINE_GRAPH_FORMAT = 1;

/**
 * The first chant whose graph carries `nodes[].facts` and `edges[].grain`
 * (#4527, #4529, #4528): a live read through an engine (the terraform
 * lexicon's read of `choudoufu live-graph -json -from-plan`, which writes
 * `ResourceMetadata.facts` and the observation's `edges`), and a plunge
 * member's checked-in `engine-graph.json` in the pulumi lexicon's member
 * read. A reader treats a graph from an older chant as having neither. The
 * engine side's floor for the terraform read is that lexicon's
 * `MIN_CHOUDOUFU_GRAPH_VERSION`.
 */
export const ENGINE_FACTS_FLOOR = "0.124.54";

/**
 * The first chant whose graph and drift records agree on ownership (#5333):
 * `DRIFT_VERDICT_ENGINE_OWNERSHIP`, `engineOwnershipOfDrift` and
 * `driftVerdictOfEngineOwnership` in `@intentius/chant/drift-record` map a drift record's verdict to the
 * graph's `facts.ownership` and back, and `chant graph --live --overlay` (so
 * `chant workspace graph --live --overlay`) puts a choudoufu live root's
 * `pending`, `unowned` and `foreign` facts on the declared nodes, read from
 * the terraform lexicon's `ObservationResult.engineFacts`, as a plunge
 * member's declared nodes carry them.
 */
export const ENGINE_OWNERSHIP_FLOOR = NEXT_RELEASE;

/** The marker values an engine read or recorded for one node. */
export interface EngineMarkers {
  /** The estate name, or plunge's `<project>/<stack>`. A digest under encoding `digest`. */
  owner?: string;
  /** The tofu-address value, or plunge's URN without stack and project. Same encoding rule as `owner`. */
  address?: string;
  /** How `owner` and `address` are written on the object. */
  encoding: "plain" | "escaped" | "digest";
  /** `live`: read off the live object. `record`: what the engine's record says it wrote. */
  source: "live" | "record";
}

/** One cloud identifier of a node. */
export interface EngineCloudId {
  kind: "import-id" | "arn" | "provider-id" | "self-link" | "k8s-uid";
  value: string;
}

/** One version of a node's record. No record values. */
export interface EngineRecordVersion {
  id: string;
  /** ISO 8601 UTC. */
  writtenAt: string;
  current: boolean;
  deleted: boolean;
}

/** The versions of a node's record, when the run asked for them (`-history`, `--versions`). */
export interface EngineRecordVersions {
  /** False for a store that replaces records in place (local, Kubernetes). */
  kept: boolean;
  /** Newest first. */
  versions: EngineRecordVersion[];
}

/**
 * What an ownership engine observed about one node (#4520). Never read for a
 * decision. Every field is optional: one the engine cannot supply is absent,
 * never guessed, and a reader shows it as unknown.
 */
export interface EngineFacts {
  /** The engine's ownership verdict. A node built from configuration alone has none. */
  ownership?: "bound" | "unowned" | "pending" | "foreign";
  markers?: EngineMarkers;
  /** What bound the node: a marker, the engine's record, or its name. */
  ownedBy?: "marker" | "record" | "name";
  /** The node's cloud ids. The first is the primary one and equals `physicalId` when both are set. */
  cloudIds?: EngineCloudId[];
  recordVersions?: EngineRecordVersions;
  /** ISO 8601 UTC, when this node's live facts were read. */
  observedAt?: string;
  /** The rows behind `ownership` for this one node (#5402). Absent when the engine's documents hold none for it. */
  ownershipRows?: EngineOwnershipRows;
}

/**
 * Why a plan left a node out (#5402): choudoufu `live-plan`'s `omissions[]`
 * row for the address, as printed.
 */
export interface EngineOmission {
  /** The engine's own code: `ABSENT`, `UNOWNED`, `NEEDS_DISCOVERY`, `FAILED` and the rest. */
  reason: string;
  /** The engine's sentence for this node. */
  detail: string;
}

/** One argument a content match compared, and the value both sides hold. */
export interface EngineMatchedArgument {
  attribute: string;
  value: string;
}

/**
 * How to adopt a live object that sits at a declared identity (#5402): the
 * marker values that claim it for this member, choudoufu's `adopt_tofu_estate`
 * and `adopt_tofu_address`.
 */
export interface EngineAdoption {
  /** The owner marker value to write: the estate, or plunge's `<project>/<stack>`. */
  owner?: string;
  /** The address marker value to write, in the encoding the engine writes it. */
  address?: string;
  /** The one-line command the engine composed for the write, when it printed one. */
  command?: string;
  /** On a content match (choudoufu `adoptable[]`): the arguments the sweep compared, in its order. */
  matched?: EngineMatchedArgument[];
}

/** Which of an engine's reads could not see a node. */
export type EngineGapRead = "listing" | "graph";

/**
 * One thing a read could not see about a node (#5402). `listing` is
 * choudoufu `live-ls`'s `gaps[]`: the tag listing can never list this
 * instance, and `reason` is the rung that says why (`record`,
 * `declaration-carried`). `graph` is the engine graph document's own
 * `meta.engineGraph.gaps` entry for the node, from choudoufu or plunge.
 */
export interface EngineGap {
  read: EngineGapRead;
  reason: string;
  detail: string;
}

/**
 * The per-node rows an ownership engine prints beside its verdict (#5402),
 * each with the engine's own words. chant fills them from the documents the
 * engine prints: choudoufu's `live-plan -json` and, when asked, `live-ls
 * -json`, and either engine's `meta.engineGraph.gaps`. An engine may also
 * print them on a node's `facts`. Every field is optional, and a node with
 * none carries no `ownershipRows`.
 */
export interface EngineOwnershipRows {
  /** How the plan bound the node, in the engine's word (choudoufu `bound[].source`: `marker`, `record`, `derived`, `cache`). */
  boundBy?: string;
  /** The values that identify the bound object, by argument (choudoufu `bound[].identity_values`). */
  identityValues?: Record<string, string>;
  /** Why the plan left the node out. */
  omission?: EngineOmission;
  /** How to adopt the live object at the node's identity. */
  adopt?: EngineAdoption;
  /** What a read could not see. */
  gaps?: EngineGap[];
  /** Whether the engine's marker listing holds the object under this member's marker. Set on a bound node when the listing ran. */
  listed?: boolean;
}

/** The first chant whose graph carries `facts.ownershipRows` (#5402). */
export const ENGINE_OWNERSHIP_ROWS_FLOOR = NEXT_RELEASE;

const GAP_READS: ReadonlySet<string> = new Set<EngineGapRead>(["listing", "graph"]);

const rowRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const rowString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** `gaps` as {@link EngineGap}s, keeping only entries of that shape. */
export function engineGapsOf(value: unknown): EngineGap[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((g) => {
    const r = rowRecord(g);
    const read = rowString(r?.read);
    const reason = rowString(r?.reason);
    return r && read && GAP_READS.has(read) && reason ? [{ read: read as EngineGapRead, reason, detail: typeof r.detail === "string" ? r.detail : "" }] : [];
  });
}

/**
 * `ownershipRows` as an engine printed it on a node, keeping only the fields
 * and shapes {@link EngineOwnershipRows} declares. Undefined when none is left.
 */
export function engineOwnershipRowsOf(value: unknown): EngineOwnershipRows | undefined {
  const v = rowRecord(value);
  if (!v) return undefined;
  const out: EngineOwnershipRows = {};
  const boundBy = rowString(v.boundBy);
  if (boundBy) out.boundBy = boundBy;
  const ids = rowRecord(v.identityValues);
  if (ids) {
    const values = Object.fromEntries(Object.entries(ids).filter((e): e is [string, string] => typeof e[1] === "string"));
    if (Object.keys(values).length > 0) out.identityValues = values;
  }
  const omission = rowRecord(v.omission);
  const reason = rowString(omission?.reason);
  if (omission && reason) out.omission = { reason, detail: typeof omission.detail === "string" ? omission.detail : "" };
  const adopt = rowRecord(v.adopt);
  if (adopt) {
    const matched = (Array.isArray(adopt.matched) ? adopt.matched : []).flatMap((m) => {
      const r = rowRecord(m);
      const attribute = rowString(r?.attribute);
      return attribute ? [{ attribute, value: typeof r!.value === "string" ? r!.value : "" }] : [];
    });
    const a: EngineAdoption = {
      ...(rowString(adopt.owner) ? { owner: rowString(adopt.owner) } : {}),
      ...(rowString(adopt.address) ? { address: rowString(adopt.address) } : {}),
      ...(rowString(adopt.command) ? { command: rowString(adopt.command) } : {}),
      ...(matched.length > 0 ? { matched } : {}),
    };
    if (Object.keys(a).length > 0) out.adopt = a;
  }
  const gaps = engineGapsOf(v.gaps);
  if (gaps.length > 0) out.gaps = gaps;
  if (typeof v.listed === "boolean") out.listed = v.listed;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Two sets of rows for one node as one: `b`'s fields win, and the gaps of
 * both are kept, each once. Undefined when both are.
 */
export function mergeOwnershipRows(a: EngineOwnershipRows | undefined, b: EngineOwnershipRows | undefined): EngineOwnershipRows | undefined {
  if (!a) return b;
  if (!b) return a;
  const gaps: EngineGap[] = [];
  const seen = new Set<string>();
  for (const g of [...(a.gaps ?? []), ...(b.gaps ?? [])]) {
    const key = `${g.read}\0${g.reason}\0${g.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push(g);
  }
  const { gaps: _a, ...restA } = a;
  const { gaps: _b, ...restB } = b;
  return { ...restA, ...restB, ...(gaps.length > 0 ? { gaps } : {}) };
}

/**
 * `facts` with `rows` added under `ownershipRows`, merged with any the facts
 * already carry. New facts when there were none; `facts` itself when `rows`
 * is undefined.
 */
export function withOwnershipRows(facts: EngineFacts | undefined, rows: EngineOwnershipRows | undefined): EngineFacts | undefined {
  if (!rows) return facts;
  const merged = mergeOwnershipRows(facts?.ownershipRows, rows)!;
  return { ...(facts ?? {}), ownershipRows: merged };
}

/**
 * What an edge joins (#4520): two blocks, two instances, or a property of one
 * instance to another. Absent on an edge whose source does not say.
 */
export type EdgeGrain = "block" | "instance" | "property";

/** The engine that printed the document. */
export interface EngineGraphEngine {
  /** `choudoufu` or `plunge`. */
  name: string;
  version?: string;
}

/** What the read covered: a choudoufu estate or a plunge stack. */
export type EngineGraphScope =
  | { kind: "estate"; estate: string }
  | { kind: "stack"; project: string; stack: string };

/** The marker keys and encodings the engine passes into its sweep packages, printed once per document. */
export interface EngineMarkerScheme {
  ownerKey: string;
  addressKey: string;
  /** Keys a long value continues into (`tofu-slot`, `plunge-urn-2`). */
  continuationKeys?: string[];
  encoding: {
    tags: "plain" | "escaped" | "digest";
    labels: "plain" | "escaped" | "digest";
  };
}

/** A node the engine could not describe, and why. */
export interface EngineGraphGap {
  address: string;
  reason: string;
  detail?: string;
}

/** `meta.engineGraph` on an engine graph document. */
export interface EngineGraphMeta {
  /** {@link ENGINE_GRAPH_FORMAT}. */
  format: 1;
  engine: EngineGraphEngine;
  scope: EngineGraphScope;
  /** ISO 8601 UTC, when the read started. Absent when nothing was read live. */
  observedAt?: string;
  markerScheme?: EngineMarkerScheme;
  gaps?: EngineGraphGap[];
}

/** The open `meta` bag of an engine graph document, holding `engineGraph`. */
export interface EngineGraphDocumentMeta {
  engineGraph: EngineGraphMeta;
  [key: string]: unknown;
}

/**
 * The one JSON document `choudoufu live-graph -json` and `plunge graph --json`
 * print. A `GraphIR` at version 1: node ids are the engine's own addresses
 * (choudoufu's instance address, plunge's URN), and readers map them with
 * `entityKeyFor`, `observedInstanceNodeId` and `pulumiNodeKey`.
 */
export interface EngineGraphDocument extends Omit<GraphIR, "version" | "meta"> {
  version: 1;
  meta: EngineGraphDocumentMeta;
}
