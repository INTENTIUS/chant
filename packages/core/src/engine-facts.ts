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

/** The format of {@link EngineGraphMeta}. Moves only for a change a reader could not ignore. */
export const ENGINE_GRAPH_FORMAT = 1;

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
