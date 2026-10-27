/**
 * behold#1029: AWS Signature Version 4 for the lister's one AWS call.
 *
 * Signed by hand with node:crypto rather than through the AWS SDK, so the
 * lister builds no SDK client (no client to hold a mutating command, no
 * default provider chain) and adds no dependency. Only what Cloud Control's
 * JSON protocol needs: a POST to `/` with no query string.
 */

import { createHash, createHmac } from "node:crypto";
import type { AwsStaticCredentials } from "./credentials";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20261026T120000Z` and `20261026` for a date. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * The headers to send, `Authorization` included. `headers` must not already
 * hold `host` or `x-amz-date`; they are added here.
 */
export function signV4(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsStaticCredentials;
  now: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const { amzDate, dateStamp } = amzDates(input.now);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim();
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const payloadHash = sha256Hex(input.body);

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [input.method, url.pathname || "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
