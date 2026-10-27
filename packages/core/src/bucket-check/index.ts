/**
 * chant#4558: the shared bucket check in CI core.
 *
 * terragucci init (terragucci#1285) and `plywood init` (plywood#3) both
 * reuse a team's existing state bucket, and the engines behind them (plunge,
 * choudoufu) refuse to open one without versioning, a lifecycle rule that
 * expires noncurrent versions, and a public access block. This check reads
 * the same settings with the same rules, so init never passes a bucket the
 * engine then refuses. It reads only: three to four GETs, no write, no
 * bucket created.
 *
 * The products hold the words. A {@link BucketReport} carries each setting's
 * verdict, what the store has, and the fix command; the product writes the
 * headline around it.
 *
 * The shared fixture set is ./fixtures/{s3,gcs,azure}.json, published as
 * `@intentius/chant/bucket-check/fixtures/<store>.json`. Each case is the
 * store's API answer and the verdicts it must produce; chant's test runs
 * them through the evaluators here, and an engine's test can run the same
 * files through its own contract check.
 */

import { checkAzureBlob, type AzureBlobTarget, type AzureReadOptions } from "./azure";
import { checkGcsBucket, type GcsBucketTarget, type GcsReadOptions } from "./gcs";
import { checkS3Bucket, type S3BucketTarget, type S3ReadOptions } from "./s3";
import type { BucketReport } from "./types";

export * from "./types";
export { BucketCheckError, namespacePrefix } from "./wire";
export { evaluateS3, readS3, checkS3Bucket, s3LifecycleFix, type S3BucketTarget, type S3Input, type S3LifecycleRule } from "./s3";
export { evaluateGcs, readGcs, checkGcsBucket, gcsLifecycleFix, type GcsBucketTarget, type GcsInput, type GcsLifecycleRule } from "./gcs";
export { evaluateAzure, readAzure, checkAzureBlob, azureLifecycleFix, type AzureBlobTarget, type AzureInput, type AzureManagementPolicyRule } from "./azure";

export type BucketTarget = S3BucketTarget | GcsBucketTarget | AzureBlobTarget;

export interface CheckBucketOptions extends S3ReadOptions, GcsReadOptions, AzureReadOptions {
  /**
   * Key prefixes the product writes under (an estate's records, a stack's
   * state). A lifecycle rule scoped to a prefix is credited only when it
   * contains each of these. Empty credits only an unfiltered rule.
   */
  namespaces?: readonly string[];
  /** Days a noncurrent version is kept in the suggested lifecycle fix. Default 30. */
  recoveryDays?: number;
}

/**
 * Reads the bucket's settings and reports one finding per setting. Throws
 * {@link BucketCheckError} when nothing could be learned (no such bucket, an
 * unexpected error); a denied read is a finding with verdict "unreadable".
 */
export async function checkBucket(target: BucketTarget, options: CheckBucketOptions = {}): Promise<BucketReport> {
  switch (target.store) {
    case "s3":
      return checkS3Bucket(target, options);
    case "gcs":
      return checkGcsBucket(target, options);
    case "azblob":
      return checkAzureBlob(target, options);
  }
}
