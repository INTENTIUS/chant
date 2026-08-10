/**
 * AWS Signature Version 4, for the shared read transport (#1686).
 *
 * Two modules asked for this by name before it existed: `./read-client.ts` and
 * cedar's `lexicons/cedar/src/avp/client.ts` both send a placeholder
 * `Signature=unsigned` `Authorization` header that carries a credential scope
 * and nothing else, and both say in prose that the real thing belongs here
 * once rather than twice. Nothing else in the repo signs an AWS request — the
 * appliers (`op/activities/aws-apply.ts`) are unsigned too, which is why the
 * native paths have been emulator-scoped.
 *
 * ## No dependency
 *
 * SigV4 is four HMACs and two SHA-256s. `node:crypto` has both, so signing
 * costs nothing in the dependency tree — which matters here, because the whole
 * reason these transports are hand-written is to keep `@aws-sdk/*` and its
 * thirty-odd transitive packages out of a lexicon.
 *
 * ## What is signed, and what is not
 *
 * Header signing only. Query-string (presigned-URL) signing has no caller: the
 * read paths POST to a service endpoint, they do not hand out URLs.
 *
 * `host` is signed but never emitted. `fetch` computes `Host` from the URL and
 * forbids overriding it, so the signer derives the same value from the URL it
 * was given. A transport that rewrites the URL underneath the signer — a proxy
 * that keeps the original `Host`, say — would invalidate the signature; the
 * injectable-HTTP seam is for tests and emulators, not for URL rewriting.
 */
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

/** SHA-256 of the empty string — the payload hash of every bodyless request. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Headers that must not be signed even when a caller sets them: `authorization`
 * is the output, and the others are rewritten in transit by proxies and agents,
 * so signing them produces intermittent 403s rather than security.
 */
const UNSIGNABLE = new Set(["authorization", "connection", "expect", "user-agent", "x-amzn-trace-id"]);

/** A resolved credential set. `sessionToken` is present for STS/role credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The credential injection seam: a function the caller supplies to decide, by
 * whatever means it likes, what to sign with. Returning `undefined` means "this
 * process has no credentials" and is respected as an answer, not overridden.
 */
export type AwsCredentialResolver = () => AwsCredentials | undefined;

/** Either literal credentials or a resolver for them. */
export type AwsCredentialSource = AwsCredentials | AwsCredentialResolver;

/**
 * Credentials for a request: explicit → environment → absent.
 *
 * A resolver function is authoritative — if one is injected and it declines,
 * the environment is not consulted behind its back, because the point of
 * injecting one is to control the answer. Literal credentials are likewise
 * final. Only the no-source case falls through to `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` when set), and a half-set
 * environment — a key id with no secret — is absent rather than a signature
 * that cannot verify.
 *
 * Deliberately not implemented: the profile file, IMDS, and the container
 * credential endpoints. Each is a separate transport with its own failure and
 * caching story; a caller that has those can resolve them itself and pass the
 * result in, which is what the resolver seam is for.
 */
export function resolveCredentials(
  source?: AwsCredentialSource,
  env: Record<string, string | undefined> = process.env,
): AwsCredentials | undefined {
  if (typeof source === "function") return source();
  if (source) return source;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

/** One request to sign. `headers` are the caller's; the signer adds its own. */
export interface SigV4Request {
  method: string;
  /** Absolute URL. Its host is signed and its path/query are canonicalized. */
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Service name as it appears in the credential scope (`cloudformation`, `cloudcontrolapi`, …). */
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Signing clock. Injected by tests; otherwise now. */
  now?: Date;
}

/** `YYYYMMDDTHHMMSSZ` — the `X-Amz-Date` format, which is ISO-8601 basic. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Lowercase hex SHA-256. */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * The signing key: four chained HMACs from the secret, so the key on the wire
 * is scoped to one day, one region and one service rather than being the
 * account secret itself.
 */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, day);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, TERMINATOR);
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone and AWS
 * does not, which is the difference between a signature that verifies and one
 * that does not for any path or parameter containing them.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical path.
 *
 * Every caller of this module POSTs to `/`, so the one place implementations
 * genuinely diverge — S3 signs the path once-encoded, every other service signs
 * it twice-encoded — never arises. Segments are encoded once; a future caller
 * with a real path on a non-S3 service is the moment to revisit that.
 */
function canonicalPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.split("/").map(encodeRfc3986).join("/");
}

/** Query parameters sorted by name, then by value, each side encoded. */
function canonicalQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  search.forEach((value, name) => pairs.push([encodeRfc3986(name), encodeRfc3986(value)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * Header names lowercased, values trimmed with internal whitespace runs
 * collapsed, sorted by name. Returns the canonical block and the `;`-joined
 * signed-header list that has to agree with it exactly.
 */
export function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), value.trim().replace(/\s+/g, " ")] as const)
    .filter(([name]) => !UNSIGNABLE.has(name))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

/** The canonical request, verbatim as it is hashed into the string to sign. */
export function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
): { canonical: string; signed: string } {
  const { canonical: headerBlock, signed } = canonicalHeaders(headers);
  return {
    canonical: [
      method.toUpperCase(),
      canonicalPath(url.pathname),
      canonicalQuery(url.searchParams),
      headerBlock,
      signed,
      payloadHash,
    ].join("\n"),
    signed,
  };
}

/** The string to sign: algorithm, timestamp, scope, hashed canonical request. */
export function stringToSign(timestamp: string, scope: string, canonical: string): string {
  return [ALGORITHM, timestamp, scope, sha256Hex(canonical)].join("\n");
}

/**
 * The caller's headers plus everything SigV4 adds: `x-amz-date`,
 * `x-amz-content-sha256`, `x-amz-security-token` when the credentials are
 * temporary, and the `Authorization` header itself.
 *
 * `host` is signed (AWS requires it) but not returned — see the module header.
 */
export function signRequest(request: SigV4Request): Record<string, string> {
  const url = new URL(request.url);
  const timestamp = amzDate(request.now ?? new Date());
  const day = timestamp.slice(0, 8);
  const payloadHash = request.body.length === 0 ? EMPTY_PAYLOAD_SHA256 : sha256Hex(request.body);

  const signable: Record<string, string> = {
    ...request.headers,
    host: url.host,
    "x-amz-date": timestamp,
    "x-amz-content-sha256": payloadHash,
    ...(request.credentials.sessionToken ? { "x-amz-security-token": request.credentials.sessionToken } : {}),
  };

  const { canonical, signed } = canonicalRequest(request.method, url, signable, payloadHash);
  const scope = `${day}/${request.region}/${request.service}/${TERMINATOR}`;
  const key = signingKey(request.credentials.secretAccessKey, day, request.region, request.service);
  const signature = hmac(key, stringToSign(timestamp, scope, canonical)).toString("hex");

  const { host: _host, ...emitted } = signable;
  return {
    ...emitted,
    authorization:
      `${ALGORITHM} Credential=${request.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signed}, Signature=${signature}`,
  };
}
