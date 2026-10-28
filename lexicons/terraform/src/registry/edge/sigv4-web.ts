/**
 * AWS Signature Version 4 with Web Crypto, for the registry edge function's
 * token reads (chant#4590). chant's one AWS signer
 * (packages/core/src/cloud-lister/sigv4.ts) hashes with node:crypto, which a
 * browser-platform bundle of registry/edge must not reach (chant#4589), so
 * this is the same canonical request built on crypto.subtle. It signs only
 * what the edge sends: a JSON POST to an AWS query endpoint, with `host`,
 * `x-amz-date`, `x-amz-target`, `content-type` and the session token.
 *
 * Its signatures match core's signer for the same input; the test checks
 * the two against each other.
 */

/** The credentials a request is signed with: the function's execution role on Lambda@Edge. */
export interface EdgeAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

async function hmac(key: string | ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const raw: BufferSource = typeof key === "string" ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(text));
}

const encodeRfc3986 = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => pairs.push([encodeRfc3986(k), encodeRfc3986(v)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * The headers to send with `body`, `authorization` included, in core's
 * signer's shape: lower-case names, `host` and `x-amz-date` added.
 */
export async function signV4Web(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: EdgeAwsCredentials;
  now: Date;
}): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(input.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method.toUpperCase(), url.pathname || "/", canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
