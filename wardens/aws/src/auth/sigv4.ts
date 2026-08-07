/**
 * Minimal AWS Signature Version 4 signer (node:crypto only — the wardens ship
 * dependency-light, so no @aws-sdk/*). Covers exactly what the warden sends:
 * POST to a service root with an x-amz-json-1.1 body. Session tokens are
 * supported via the X-Amz-Security-Token header.
 */

import { createHash, createHmac } from "node:crypto";

export interface Sigv4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface Sigv4Request {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: Sigv4Credentials;
  /** Injectable clock for tests. Defaults to now. */
  date?: Date;
}

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encode a path segment the way SigV4 canonicalization wants. */
function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/") || "/";
}

/**
 * Returns the headers to send: the input headers plus Host, X-Amz-Date,
 * optionally X-Amz-Security-Token, and Authorization.
 */
export function signRequest(req: Sigv4Request): Record<string, string> {
  const now = req.date ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.url.host,
    "x-amz-date": amzDate,
    ...(req.credentials.sessionToken ? { "x-amz-security-token": req.credentials.sessionToken } : {}),
  };

  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim();

  const canonicalHeaders = sortedNames.map((h) => `${h}:${lower[h]}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const payloadHash = sha256(req.body);

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(req.url.pathname),
    req.url.searchParams.toString(), // canonical query (already sorted-enough: warden sends none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${req.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
