/**
 * Object stores in chant core (#4554): one client per cloud for S3 (and
 * S3-compatible stores, ./s3.ts), Google Cloud Storage's JSON API (./gcs.ts)
 * and Azure Blob Storage (./azure-blob.ts), shared by the products, the
 * report URLs (../pr-report-url.ts) and the terraform lexicon's state
 * clients. A bucket URL names the store by its scheme, and ./from-env.ts
 * makes the client from it and the job's environment.
 *
 * Lifted from terragucci's report/object-store.ts, s3.ts, gcs.ts,
 * azure-blob.ts and bucket.ts (INTENTIUS/terragucci e962b2c), so terragucci
 * deletes its copies (terragucci#1282). The S3 client signs through chant's
 * one AWS signer (../cloud-lister/sigv4.ts).
 */

import { CLOUD_TARGETS_ENV, readTargetsFile, type IdentityCloud } from "../ci-identity";

export type StoreFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** A store that sends no headers (or a test's fake) gets no conditional writes. */
  headers?: { get(name: string): string | null };
}>;

/**
 * The product keys that fix a setup error (#4584), for a product that has
 * them: terragucci passes `{ oidc: "oidc", gcp: "oidc.gcp", azure: "oidc.azure" }`.
 * Each key a message can name is left out of chant's own wording when unset.
 */
export interface StoreHints {
  /** The key that gives the job an OIDC identity for AWS, such as `oidc`. */
  oidc?: string;
  /** The key that gives the job a Google credentials file, such as `oidc.gcp`. */
  gcp?: string;
  /** The key that gives the job an Azure federated identity, such as `oidc.azure`. */
  azure?: string;
}

// The errors and write conditions live in ./errors.ts, which imports nothing (chant#4589).
export { StoreError, StoreConflict, isStoreConflict, type StoreCondition } from "./errors";
import { StoreError, type StoreCondition } from "./errors";

export interface ObjectStore {
  /** `s3://<bucket>`, `gs://<bucket>` or `az://<account>/<container>`, for messages. */
  readonly location: string;
  /** Write an object; with `when`, only if it still holds, else StoreConflict. The answer carries the new version when the store sends one. */
  put(key: string, body: string | Uint8Array, contentType: string, when?: StoreCondition): Promise<{ etag?: string }>;
  /** The object's text and version, or no text when there is none. */
  read(key: string): Promise<{ body?: string; etag?: string }>;
  get(key: string): Promise<string | undefined>;
  /** A link that reads `key` for `seconds` (a presigned URL, a signed URL, a SAS), and when it stops working. */
  presign(key: string, seconds: number, now?: Date): Promise<{ url: string; expires: Date }>;
}

/** The longest a link lives: seven days, the limit of S3, GCS and a user delegation SAS alike. */
export const PRESIGN_MAX_SECONDS = 7 * 24 * 3600;

export type BucketRef = { kind: "s3"; bucket: string } | { kind: "gcs"; bucket: string } | { kind: "azure"; account: string; container: string };

/** `s3://<bucket>` or a bare bucket name, `gs://<bucket>`, or `az://<account>/<container>`. `setting` names the value in the error. */
export function parseBucketUrl(url: string, setting = "the bucket"): BucketRef {
  const u = url.trim().replace(/\/+$/, "");
  let m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,221}[a-z0-9])$/.exec(u);
  if (m) return { kind: "gcs", bucket: m[1] };
  m = /^az:\/\/([a-z0-9]{3,24})\/([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62})$/.exec(u);
  if (m) return { kind: "azure", account: m[1], container: m[2] };
  m = /^(?:s3:\/\/)?([^/:\s]+)$/.exec(u);
  if (m) return { kind: "s3", bucket: m[1] };
  throw new StoreError(`${setting} must be s3://<bucket>, gs://<bucket> or az://<account>/<container>, not ${url}`);
}

export const bucketUrl = (b: BucketRef): string => (b.kind === "azure" ? `az://${b.account}/${b.container}` : `${b.kind === "gcs" ? "gs" : "s3"}://${b.bucket}`);

/** A key as a URL path: each segment percent-encoded the strict way (RFC 3986), the slashes kept. */
export const encodePath = (key: string): string => key.split("/").map(encodeStrict).join("/");

export const encodeStrict = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The first value of an XML element, unescaped. Enough for the small answers these stores send. */
export const xmlText = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
};

/**
 * One version of an object, as the store's list of the object's versions
 * names it: its id, when it was written, whether it is the one the store
 * serves now, and, on S3, whether it is a delete marker. Metadata only.
 */
export interface ObjectVersion {
  version_id: string;
  written_at: string;
  latest: boolean;
  deleted?: boolean;
}

/** Each block of an XML element in a list answer, such as every `<Version>` in a ListObjectVersions page. */
export const xmlBlocks = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);

/** A time as the stores write it in a query: `2026-10-07T12:00:00Z`, no milliseconds. */
export const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The global fetch, as a StoreFetch. */
export const defaultFetch: StoreFetch = (url, init) => fetch(url, init as RequestInit);

/**
 * The variables the job's OIDC trade left for identity `id` of `cloud` in
 * the {@link CLOUD_TARGETS_ENV} file (../ci-identity.ts), or undefined when
 * the job has no such file. Refused when the file has none for `id`.
 */
export function tradedVars(env: NodeJS.ProcessEnv, cloud: IdentityCloud, id: string): Record<string, string> | undefined {
  const path = env[CLOUD_TARGETS_ENV];
  if (!path) return undefined;
  let vars: Record<string, string> | undefined;
  try {
    vars = readTargetsFile(path).clouds[cloud]?.vars[id];
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  if (!vars) throw new StoreError(`the job's trade left no credentials for ${id}`);
  return vars;
}

/** Every identity of `cloud` the job's trade left credentials for, with them; empty when the job traded none. */
export function tradedIdentities(env: NodeJS.ProcessEnv, cloud: IdentityCloud): Record<string, Record<string, string>> {
  const path = env[CLOUD_TARGETS_ENV];
  if (!path) return {};
  try {
    return readTargetsFile(path).clouds[cloud]?.vars ?? {};
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
}
