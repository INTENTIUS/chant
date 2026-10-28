/**
 * AWS Signature Version 4, chant's one AWS signer (behold#1029, #4554).
 *
 * Signed by hand with node:crypto rather than through the AWS SDK, so no
 * SDK client is built (no client to hold a mutating command, no default
 * provider chain) and no dependency is added. The cloud lister's Cloud
 * Control calls, the object-store S3 client (../object-store/s3.ts), the
 * snapshot store's S3 medium (../lifecycle/snapshot-store-s3.ts), the
 * terraform lexicon's state client and the aws lexicon's Cloud Control and
 * CloudFormation reads (#4583) all sign through {@link signV4}, and S3's
 * presigned links through {@link presignV4}.
 */

import { createHash, createHmac } from "node:crypto";
import type { AwsStaticCredentials } from "./credentials";

/** The SHA-256 of an empty body, hex. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A body's SHA-256, hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return typeof data === "string" ? createHash("sha256").update(data, "utf8").digest("hex") : createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding, as SigV4 signs a query and S3 a key. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20261026T120000Z` and `20261026` for a date. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** The key a day's signatures for one region and service are made with. */
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

/** A URL's query in canonical order, each name and value RFC 3986 encoded. */
function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => pairs.push([encodeRfc3986(k), encodeRfc3986(v)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * The headers to send, `Authorization` included. `headers` must not already
 * hold `host` or `x-amz-date`; they are added here, and `host` is kept in
 * the answer unless `omitHost`. The URL's pathname is the canonical URI as
 * it stands, so a caller encodes a key once (S3's rule) before it signs.
 * `payloadHash` stands in for hashing `body`; `contentSha256` sends it as
 * `x-amz-content-sha256`, which S3 requires. A header named (any case) in
 * `unsignedHeaders` is sent but left out of the signature, for headers a
 * proxy or agent may rewrite in transit, such as `user-agent` (#4583).
 */
export function signV4(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsStaticCredentials;
  now: Date;
  payloadHash?: string;
  contentSha256?: boolean;
  omitHost?: boolean;
  unsignedHeaders?: Iterable<string>;
}): Record<string, string> {
  const url = new URL(input.url);
  const { amzDate, dateStamp } = amzDates(input.now);
  const payloadHash = input.payloadHash ?? (input.body.length === 0 ? EMPTY_PAYLOAD_SHA256 : sha256Hex(input.body));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (input.contentSha256) headers["x-amz-content-sha256"] = payloadHash;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const unsigned = new Set([...(input.unsignedHeaders ?? [])].map((n) => n.toLowerCase()));
  const names = Object.keys(headers).filter((n) => !unsigned.has(n)).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method.toUpperCase(), url.pathname || "/", canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service)).update(stringToSign, "utf8").digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  if (input.omitHost) delete headers.host;
  return headers;
}

/**
 * A presigned GET (Signature Version 4 in the query string, #4554): whoever
 * holds the URL reads that one object for `seconds`. Only `host` is signed,
 * and the payload is UNSIGNED-PAYLOAD. A query the URL already carries is
 * signed with the rest (#4572): an RDS IAM token is the presigned
 * `?Action=connect&DBUser=<user>` of the database's host and port.
 */
export function presignV4(input: { url: string; region: string; service: string; credentials: AwsStaticCredentials; seconds: number; now: Date }): string {
  const url = new URL(input.url);
  const { amzDate, dateStamp } = amzDates(input.now);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const params: Record<string, string> = {
    ...Object.fromEntries(url.searchParams),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.seconds),
    ...(input.credentials.sessionToken ? { "X-Amz-Security-Token": input.credentials.sessionToken } : {}),
    "X-Amz-SignedHeaders": "host",
  };
  const query = Object.keys(params).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k]!)}`).join("&");
  const canonical = ["GET", url.pathname, query, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service)).update(toSign).digest("hex");
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}
