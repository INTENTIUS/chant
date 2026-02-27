/**
 * GcsBucket composite — StorageBucket with encryption, uniform access, and lifecycle.
 */

export interface GcsBucketProps {
  /** Bucket name. */
  name: string;
  /** GCS location (default: "US"). */
  location?: string;
  /** Storage class (default: "STANDARD"). */
  storageClass?: "STANDARD" | "NEARLINE" | "COLDLINE" | "ARCHIVE";
  /** Enable uniform bucket-level access (default: true). */
  uniformBucketLevelAccess?: boolean;
  /** Enable versioning (default: false). */
  versioning?: boolean;
  /** KMS key name for encryption. */
  kmsKeyName?: string;
  /** Lifecycle rule: delete objects older than N days. */
  lifecycleDeleteAfterDays?: number;
  /** Lifecycle rule: transition to Nearline after N days. */
  lifecycleNearlineAfterDays?: number;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface GcsBucketResult {
  bucket: Record<string, unknown>;
}

/**
 * Create a GcsBucket composite.
 *
 * @example
 * ```ts
 * import { GcsBucket } from "@intentius/chant-lexicon-gcp";
 *
 * const { bucket } = GcsBucket({
 *   name: "my-data-bucket",
 *   location: "US",
 *   versioning: true,
 *   lifecycleDeleteAfterDays: 365,
 * });
 * ```
 */
export function GcsBucket(props: GcsBucketProps): GcsBucketResult {
  const {
    name,
    location = "US",
    storageClass = "STANDARD",
    uniformBucketLevelAccess = true,
    versioning = false,
    kmsKeyName,
    lifecycleDeleteAfterDays,
    lifecycleNearlineAfterDays,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const spec: Record<string, unknown> = {
    location,
    storageClass,
    uniformBucketLevelAccess,
  };

  if (versioning) {
    spec.versioning = { enabled: true };
  }

  if (kmsKeyName) {
    spec.encryption = { defaultKmsKeyName: kmsKeyName };
  }

  const lifecycleRules: Array<Record<string, unknown>> = [];

  if (lifecycleDeleteAfterDays) {
    lifecycleRules.push({
      action: { type: "Delete" },
      condition: { age: lifecycleDeleteAfterDays },
    });
  }

  if (lifecycleNearlineAfterDays) {
    lifecycleRules.push({
      action: { type: "SetStorageClass", storageClass: "NEARLINE" },
      condition: { age: lifecycleNearlineAfterDays },
    });
  }

  if (lifecycleRules.length > 0) {
    spec.lifecycleRule = lifecycleRules;
  }

  const bucket: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    ...spec,
  };

  return { bucket };
}
