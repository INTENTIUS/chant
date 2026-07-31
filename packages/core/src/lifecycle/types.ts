import type { ResourceMetadata, ArtifactMetadata } from "../lexicon";
import type { UnobservedEntity } from "../observation";
import type { DeepResourceObservation } from "../deep-observation";
import type { IREdge } from "../graph-ir";

export type { ResourceMetadata, ArtifactMetadata } from "../lexicon";

/**
 * How much of each resource an observation actually read (#1267).
 *
 * `identity` is the thin path: logical name, type, physical id, status. It is
 * what a snapshot recorded before deep reads existed, and it stays the default
 * because a deep read costs more provider calls and a larger record.
 *
 * `deep` additionally carries each resource's normalized property tree, which
 * is what a fold over topology needs — a subnet's route-table association, a
 * security group's rules. A consumer must branch on this rather than assume:
 * asking an `identity` snapshot a property question has no answer, and
 * silently returning nothing would read as "no such resources".
 */
export type ObservationDepth = "identity" | "deep";

/**
 * State snapshot for a single lexicon in an environment.
 */
export interface LifecycleSnapshot {
  lexicon: string;
  environment: string;
  /** Deployed stack name, for a multi-stack project (see `stacks` in
   * ChantConfig). Absent for single-stack projects. Snapshots are stored per
   * `<env>/<stack>/<lexicon>` when set, so sibling stacks don't overwrite. */
  stack?: string;
  /** Main branch commit this corresponds to */
  commit: string;
  /** ISO timestamp when the snapshot was taken */
  timestamp: string;
  /** Resource metadata keyed by logical name */
  resources: Record<string, ResourceMetadata>;
  /**
   * Declared entities this observation could not read (#1089), keyed by logical
   * name. Additive and optional: a snapshot without it observed everything it
   * was asked about. Present so a later diff can tell "was not there when the
   * snapshot was taken" from "was never looked at".
   */
  unobserved?: Record<string, UnobservedEntity>;
  /** Artifact metadata keyed by server-side identifier (lexicon-specific). */
  artifacts?: Record<string, ArtifactMetadata>;
  /**
   * How much of each resource this snapshot read (#1267). Absent means
   * `identity` — every snapshot written before deep reads existed was thin, and
   * treating a missing field as unknown rather than as thin would invalidate
   * them all.
   */
  depth?: ObservationDepth;
  /**
   * Normalized per-resource property trees, present only at `deep` depth and
   * keyed by the same logical names as `resources`.
   *
   * Kept beside `resources` rather than merged into it so the thin record stays
   * exactly what it always was: a reader that only wants identity does not have
   * to learn a new shape, and an old snapshot and a new one parse the same way.
   */
  properties?: Record<string, DeepResourceObservation>;
  /**
   * Relationships observed between the recorded resources (#1266).
   *
   * `resources` says what existed; without this a snapshot cannot say how any
   * of it connected, so a fold over topology has nothing to traverse when the
   * snapshot is replayed. That is the difference between a snapshot answering
   * "which instances exist" and answering "which are reachable from the
   * internet" — and the second is the whole reason the graph is worth
   * recording.
   *
   * Absent on every snapshot written before this, which is read as "no
   * relationships recorded" rather than "no relationships existed".
   */
  edges?: IREdge[];
  /** Build digest at snapshot time — what was declared when this snapshot was taken */
  digest?: BuildDigest;
}

/**
 * Digest of a single resource declaration.
 */
export interface ResourceDigest {
  /** Entity type (e.g. AWS::S3::Bucket) */
  type: string;
  /** Which lexicon owns this resource */
  lexicon: string;
  /** Hash of deterministically-serialized declaration props */
  propsHash: string;
}

/**
 * Digest of the entire build at a point in time.
 */
export interface BuildDigest {
  /** Per-resource digest keyed by logical name */
  resources: Record<string, ResourceDigest>;
  /** Resource-level dependency graph */
  dependencies: Record<string, string[]>;
  /** Cross-lexicon output bridges from BuildManifest */
  outputs: Record<string, { source: string; entity: string; attribute: string }>;
  /** Lexicon-level deploy order */
  deployOrder: string[];
}

/**
 * Result of comparing two build digests.
 */
export interface DigestDiff {
  /** Resources in current build but not in previous digest */
  added: string[];
  /** Resources in previous digest but not in current build */
  removed: string[];
  /** Resources where propsHash differs */
  changed: string[];
  /** Resources where propsHash matches */
  unchanged: string[];
}
