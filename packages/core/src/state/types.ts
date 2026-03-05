import type { ResourceMetadata } from "../lexicon";

export type { ResourceMetadata } from "../lexicon";

/**
 * State snapshot for a single lexicon in an environment.
 */
export interface StateSnapshot {
  lexicon: string;
  environment: string;
  /** Main branch commit this corresponds to */
  commit: string;
  /** ISO timestamp when the snapshot was taken */
  timestamp: string;
  /** Resource metadata keyed by logical name */
  resources: Record<string, ResourceMetadata>;
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
