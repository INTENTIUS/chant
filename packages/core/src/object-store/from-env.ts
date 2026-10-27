/**
 * The client for a bucket URL (#4554): its scheme picks the store, and the
 * job's environment gives the identity (./s3.ts, ./gcs.ts and
 * ./azure-blob.ts say which variables each reads). terragucci's
 * `storeFromEnv` (report/bucket.ts).
 */
import { AzureBlobClient, azureFromEnv } from "./azure-blob";
import { parseBucketUrl, StoreError, type ObjectStore, type StoreFetch, type StoreHints } from "./common";
import { GcsClient, gcsFromEnv } from "./gcs";
import { S3Client, s3FromEnv } from "./s3";

/** Where the store is: `bucket` is `s3://<bucket>` (or a bare name), `gs://<bucket>` or `az://<account>/<container>`. */
export interface StoreWhere {
  bucket: string;
  endpoint?: string;
  /** An AWS role to assume with the job's OIDC token; S3 only. */
  role?: string;
  /** The STS session name for `role`. */
  sessionName?: string;
  /** What the bucket is called in messages, such as `reports.bucket`. Default `the bucket`. */
  setting?: string;
  /** What the role is called in messages, such as `reports.role`. Default `the role`. */
  roleSetting?: string;
  /** Product keys that fix a setup error, named in its message (#4584). Left out, the messages use chant's wording. */
  hints?: StoreHints;
}

export function storeFromEnv(where: StoreWhere, env: NodeJS.ProcessEnv = process.env, fetchFn?: StoreFetch): ObjectStore {
  const setting = where.setting ?? "the bucket";
  const b = parseBucketUrl(where.bucket, setting);
  if (b.kind !== "s3" && where.role) throw new StoreError(`${where.roleSetting ?? "the role"} is an AWS role, and ${where.bucket} is not an S3 bucket: the job writes it with its own ${where.hints?.oidc ?? "OIDC"} identity`);
  const endpoint = where.endpoint?.replace(/\/+$/, "");
  if (b.kind === "gcs") return new GcsClient(gcsFromEnv({ bucket: b.bucket, setting, ...(where.hints ? { hints: where.hints } : {}), ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  if (b.kind === "azure") return new AzureBlobClient(azureFromEnv({ account: b.account, container: b.container, setting, ...(where.hints ? { hints: where.hints } : {}), ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  return new S3Client(s3FromEnv({ ...where, setting }, env), fetchFn);
}
