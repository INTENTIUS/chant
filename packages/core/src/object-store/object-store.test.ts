/**
 * #4554: chant core's object-store clients. The S3 signing is checked
 * against AWS's published Signature Version 4 examples for S3, so the one
 * signer (../cloud-lister/sigv4.ts) the clients, the snapshot store and the
 * terraform lexicon share signs as S3 expects. The clients run against
 * in-memory fakes; nothing leaves the process.
 */

import { describe, expect, test } from "vitest";
import { presign, S3Client, sign, s3FromEnv, type S3Target } from "./s3";
import { parseBucketUrl, StoreConflict, StoreError, type StoreFetch } from "./common";
import { storeFromEnv } from "./from-env";
import { AzureBlobClient } from "./azure-blob";
import { GcsClient } from "./gcs";
import { EMPTY_PAYLOAD_SHA256 } from "../cloud-lister/sigv4";
import { signS3Request } from "../lifecycle/snapshot-store-s3";

// AWS's example keys and request (Signature Version 4 for S3, "GET Object" and "Presigned URL" examples).
const KEYS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const WHEN = new Date("2013-05-24T00:00:00Z");

describe("one AWS signer signs S3 as AWS's examples do (#4554)", () => {
  test("a GET with a Range header", () => {
    const h = sign({ region: "us-east-1", ...KEYS }, "GET", "https://examplebucket.s3.amazonaws.com/test.txt", { range: "bytes=0-9" }, EMPTY_PAYLOAD_SHA256, WHEN);
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(h.host).toBeUndefined();
  });

  test("the snapshot store's medium signs the same way", () => {
    const h = signS3Request({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9" }, body: "", region: "us-east-1", credentials: KEYS, now: WHEN });
    expect(h.authorization).toContain("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  test("a presigned GET for a day", () => {
    const url = presign({ region: "us-east-1", ...KEYS }, "https://examplebucket.s3.amazonaws.com/test.txt", 86400, WHEN);
    expect(url).toMatch(/&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  });
});

/** An S3 bucket in memory: objects with ETags, If-None-Match and If-Match honoured. */
function fakeS3(): { fetch: StoreFetch; objects: Map<string, { body: string; etag: string }> } {
  const objects = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const reply = (status: number, body = "", headers: Record<string, string> = {}) => ({ ok: status < 300, status, text: async () => body, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } });
  const fetch: StoreFetch = async (url, init) => {
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/bucket\//, ""));
    const had = objects.get(key);
    if (init.method === "GET") return had ? reply(200, had.body, { etag: had.etag }) : reply(404);
    if (init.method === "HEAD") return had ? reply(200, "", { etag: had.etag }) : reply(404);
    if (init.method === "DELETE") return objects.delete(key), reply(204);
    if (init.headers["if-none-match"] === "*" && had) return reply(412);
    if (init.headers["if-match"] !== undefined && init.headers["if-match"] !== had?.etag) return reply(412);
    const etag = `"e${++n}"`;
    objects.set(key, { body: String(init.body), etag });
    return reply(200, "", { etag });
  };
  return { fetch, objects };
}

describe("the S3 client against a fake bucket (#4554)", () => {
  const target: S3Target = { bucket: "bucket", endpoint: "http://s3.test", region: "us-east-1", ...KEYS };

  test("a put returns its ETag, a conditional put over a stale one conflicts, and putIfAbsent takes a lock once", async () => {
    const s3 = fakeS3();
    const c = new S3Client(target, s3.fetch);
    const first = await c.put("runs/index.json", "{}", "application/json");
    expect(first.etag).toBe('"e1"');
    await c.put("runs/index.json", "{\"a\":1}", "application/json", { ifMatch: first.etag! });
    await expect(c.put("runs/index.json", "{}", "application/json", { ifMatch: first.etag! })).rejects.toBeInstanceOf(StoreConflict);
    expect(await c.putIfAbsent("k.tflock", "{}", "application/json")).toBe(true);
    expect(await c.putIfAbsent("k.tflock", "{}", "application/json")).toBe(false);
    expect(await c.get("runs/index.json")).toBe("{\"a\":1}");
    await c.remove("k.tflock");
    expect((await c.head("k.tflock")).exists).toBe(false);
  });

  test("s3FromEnv names the setting a product gave in its refusal, and takes a role's traded keys", () => {
    expect(() => s3FromEnv({ bucket: "b", setting: "reports.bucket", roleSetting: "reports.role" }, {})).toThrow(/^reports\.bucket is set, .* or reports\.role$/);
    expect(s3FromEnv({ bucket: "s3://b" }, { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" })).toMatchObject({ bucket: "b", accessKeyId: "id" });
    const web = s3FromEnv({ bucket: "b", sessionName: "chant-state" }, { AWS_ROLE_ARN: "arn:aws:iam::1:role/r", AWS_WEB_IDENTITY_TOKEN_FILE: "/t" });
    expect(web).toMatchObject({ webIdentity: { roleArn: "arn:aws:iam::1:role/r", sessionName: "chant-state" } });
  });
});

describe("a bucket URL picks the store (#4554)", () => {
  test("s3, gs and az URLs", () => {
    expect(parseBucketUrl("s3://b")).toEqual({ kind: "s3", bucket: "b" });
    expect(parseBucketUrl("gs://my-bucket")).toEqual({ kind: "gcs", bucket: "my-bucket" });
    expect(parseBucketUrl("az://account1/reports")).toEqual({ kind: "azure", account: "account1", container: "reports" });
    expect(() => parseBucketUrl("https://x", "reports.bucket")).toThrow(/^reports\.bucket must be/);
  });

  test("storeFromEnv makes the client for the scheme, and refuses an AWS role for another cloud", () => {
    expect(storeFromEnv({ bucket: "gs://my-bucket" }, { GOOGLE_APPLICATION_CREDENTIALS: "/creds.json" })).toBeInstanceOf(GcsClient);
    expect(storeFromEnv({ bucket: "az://account1/reports" }, { AZURE_STORAGE_KEY: Buffer.from("k").toString("base64") })).toBeInstanceOf(AzureBlobClient);
    expect(storeFromEnv({ bucket: "b" }, { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "s" })).toBeInstanceOf(S3Client);
    expect(() => storeFromEnv({ bucket: "gs://my-bucket", role: "arn:aws:iam::1:role/r" }, {})).toThrow(StoreError);
  });

  test("storeFromEnv without hints words its errors as chant does (#4584)", () => {
    expect(() => storeFromEnv({ bucket: "gs://b" }, {})).toThrow("set GOOGLE_APPLICATION_CREDENTIALS to a credentials file (a job's OIDC setup writes one)");
    expect(() => storeFromEnv({ bucket: "az://a/c" }, {})).toThrow("(a job's OIDC setup sets them), or AZURE_STORAGE_KEY");
    expect(() => storeFromEnv({ bucket: "b" }, {})).toThrow("AWS_WEB_IDENTITY_TOKEN_FILE, or the role");
    expect(() => storeFromEnv({ bucket: "b", role: "arn:aws:iam::1:role/r" }, {})).toThrow("to assume arn:aws:iam::1:role/r");
    expect(() => storeFromEnv({ bucket: "gs://b", role: "arn:aws:iam::1:role/r" }, {})).toThrow("its own OIDC identity");
  });

  test("storeFromEnv names the product key in each setup error when given hints (#4584)", () => {
    const hints = { oidc: "oidc", gcp: "oidc.gcp", azure: "oidc.azure" };
    const base = { setting: "reports.bucket", roleSetting: "reports.role", hints };
    expect(() => storeFromEnv({ ...base, bucket: "gs://b" }, {})).toThrow(
      "reports.bucket is gs://b, but the job has no credentials for it: give the job oidc.gcp (it sets GOOGLE_APPLICATION_CREDENTIALS), or set GOOGLE_APPLICATION_CREDENTIALS to a credentials file",
    );
    expect(() => storeFromEnv({ ...base, bucket: "az://a/c" }, {})).toThrow(
      "reports.bucket is az://a/c, but the job has no credentials for it: give the job oidc.azure (it sets ARM_TENANT_ID, ARM_CLIENT_ID and ARM_OIDC_TOKEN_FILE_PATH), or set AZURE_STORAGE_KEY",
    );
    expect(() => storeFromEnv({ ...base, bucket: "b" }, {})).toThrow(
      "reports.bucket is set, but the job has no credentials for it: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE (a job with oidc sets both), or reports.role",
    );
    expect(() => storeFromEnv({ ...base, bucket: "b", role: "arn:aws:iam::1:role/r" }, {})).toThrow(
      "reports.role is set, but AWS_WEB_IDENTITY_TOKEN_FILE is not: the job needs an OIDC token to assume arn:aws:iam::1:role/r, which a job with oidc gets",
    );
    expect(() => storeFromEnv({ ...base, bucket: "gs://b", role: "arn:aws:iam::1:role/r" }, {})).toThrow(
      "reports.role is an AWS role, and gs://b is not an S3 bucket: the job writes it with its own oidc identity",
    );
  });
});
