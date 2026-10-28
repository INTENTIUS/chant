/**
 * AWS request signing for the shared read transport (#1686), through core's
 * one SigV4 signer (`@intentius/chant/cloud-lister/sigv4`, #4583).
 *
 * This lexicon kept its own SigV4 implementation until #4583; it now holds
 * only the lexicon's signing surface (`signRequest`, `resolveCredentials` and
 * the credential types cedar's AVP client restates) and the header set it
 * signs. Core does the canonicalization and the HMACs.
 *
 * ## What is signed, and what is not
 *
 * Header signing only. `host` is signed but never emitted: `fetch` computes
 * `Host` from the URL and forbids overriding it, so the signer derives the
 * same value from the URL it was given. A transport that rewrites the URL
 * underneath the signer (a proxy that keeps the original `Host`, say) would
 * invalidate the signature; the injectable-HTTP seam is for tests and
 * emulators, not for URL rewriting.
 *
 * `x-amz-content-sha256` is always sent and signed. The headers in
 * {@link UNSIGNED_HEADERS} are sent when a caller sets them but never signed.
 *
 * The canonical path is the URL's pathname as it stands (core's rule, which is
 * S3's). Every caller here POSTs to `/` or reads a Route 53 path of plain
 * segments, where that agrees with the twice-encoded form other services
 * define; a caller with a path that needs encoding is the moment to revisit it.
 */
import { signV4 } from "@intentius/chant/cloud-lister/sigv4";

/** SHA-256 of the empty string, the payload hash of every bodyless request. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Headers that are never signed even when a caller sets them: `authorization`
 * is the output, and the others are rewritten in transit by proxies and agents,
 * so signing them produces intermittent 403s rather than security.
 */
export const UNSIGNED_HEADERS: readonly string[] = ["authorization", "connection", "expect", "user-agent", "x-amzn-trace-id"];

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
 * Credentials for a request: explicit, then environment, then absent.
 *
 * A resolver function is authoritative: if one is injected and it declines,
 * the environment is not consulted behind its back, because the point of
 * injecting one is to control the answer. Literal credentials are likewise
 * final. Only the no-source case falls through to `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` when set), and a half-set
 * environment (a key id with no secret) is absent rather than a signature
 * that cannot verify.
 *
 * The shared profile files are resolved asynchronously by
 * `./credential-chain.ts`, and the read transport passes its answer in as
 * literal credentials (#3958), so this function stays synchronous. Not
 * implemented anywhere: IMDS and the container credential endpoints.
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
  /** Service name as it appears in the credential scope (`cloudformation`, `cloudcontrolapi`, ...). */
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Signing clock. Injected by tests; otherwise now. */
  now?: Date;
}

/** The headers core's signer adds, the ones {@link signRequest} returns beside the caller's own. */
const ADDED = ["x-amz-date", "x-amz-content-sha256", "x-amz-security-token", "authorization"] as const;

/**
 * The caller's headers, as given, plus everything SigV4 adds: `x-amz-date`,
 * `x-amz-content-sha256`, `x-amz-security-token` when the credentials are
 * temporary, and the `Authorization` header itself.
 *
 * `host` is signed (AWS requires it) but not returned; see the module header.
 */
export function signRequest(request: SigV4Request): Record<string, string> {
  const signed = signV4({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    region: request.region,
    service: request.service,
    credentials: request.credentials,
    now: request.now ?? new Date(),
    contentSha256: true,
    omitHost: true,
    unsignedHeaders: UNSIGNED_HEADERS,
  });
  const out: Record<string, string> = { ...request.headers };
  for (const name of ADDED) if (signed[name] !== undefined) out[name] = signed[name];
  return out;
}
