/**
 * Where the Lambda@Edge function gets its accepted tokens (chant#4590).
 * Lambda@Edge has no environment of its own, so by default the tokens are
 * built into the zip (`source: { kind: "zip" }`, terragucci#1287's
 * registry-edge.json). The function can instead read them from SSM Parameter
 * Store or Secrets Manager: the read starts when the handler is made (the
 * cold start), its answer is kept for `cacheSeconds`, and a rotation in the
 * store reaches every replica within that time with no redeploy.
 *
 * The read fails closed: while the store cannot be read, or holds no token,
 * every request gets a 503 and none reaches the bucket.
 *
 * The reads are plain fetch calls signed with ./sigv4-web.ts (Web Crypto),
 * so registry/edge stays free of Node built-ins (chant#4589). Credentials
 * default to the execution role's, which the Lambda runtime puts in
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN; the role
 * needs ssm:GetParameter (and kms:Decrypt for a SecureString under a key of
 * your own) or secretsmanager:GetSecretValue on that one name.
 */
import { tokensFromSecret } from "./edge";
import { signV4Web, type EdgeAwsCredentials } from "./sigv4-web";

/** The fetch the reads call; a test passes a fake, so no AWS call is made. */
export type EdgeAwsFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What a store read shares. */
interface StoreSourceBase {
  /**
   * The region the parameter or secret is in. Default us-east-1, where a
   * Lambda@Edge function is created; the replicas run in other regions, so
   * the function's own AWS_REGION is never used.
   */
  region?: string;
  /** Seconds a read is kept before the next request reads again. Default 300, at most 3600. */
  cacheSeconds?: number;
  /** The credentials to sign with. Default: the execution role's, from the runtime's environment. */
  credentials?: EdgeAwsCredentials | (() => Promise<EdgeAwsCredentials>);
  /** The fetch to call. Default the global fetch. */
  fetch?: EdgeAwsFetch;
}

/** An SSM parameter (String or SecureString) holding the tokens. */
export interface SsmTokenSource extends StoreSourceBase {
  kind: "ssm";
  /** The parameter's name, such as /registry/tokens. */
  name: string;
}

/** A Secrets Manager secret whose SecretString holds the tokens. */
export interface SecretsManagerTokenSource extends StoreSourceBase {
  kind: "secrets-manager";
  /** The secret's name or ARN. */
  secretId: string;
}

/** The tokens built into the function: `auth.tokens`. */
export interface ZipTokenSource {
  kind: "zip";
}

export type EdgeTokenSource = ZipTokenSource | SsmTokenSource | SecretsManagerTokenSource;

/** The tokens a store holds, and the signing key when the store names one. */
export interface StoredTokens {
  tokens: string[];
  signingKey?: string;
}

export const DEFAULT_TOKEN_CACHE_SECONDS = 300;
export const MAX_TOKEN_CACHE_SECONDS = 3600;
/** After a failed read, requests are refused for this long before the next read, so a broken store is not read once per request. */
export const FAILED_READ_BACKOFF_MS = 5_000;

/**
 * A stored value as tokens. Either the worker's REGISTRY_TOKENS form (one per
 * line or comma separated) or JSON: `{ "tokens": [...] | "a,b", "signingKey": "..." }`.
 */
export function parseStoredTokens(text: string): StoredTokens {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let doc: { tokens?: unknown; signingKey?: unknown };
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new Error("the stored tokens look like JSON but do not parse");
    }
    const tokens = Array.isArray(doc.tokens) ? doc.tokens.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => !!t) : typeof doc.tokens === "string" ? tokensFromSecret(doc.tokens) : [];
    return { tokens, ...(typeof doc.signingKey === "string" && doc.signingKey ? { signingKey: doc.signingKey } : {}) };
  }
  return { tokens: tokensFromSecret(trimmed) };
}

/** The execution role's credentials, read from the runtime's environment without importing node:process. */
function runtimeCredentials(): EdgeAwsCredentials {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("no AWS credentials in the function's runtime (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)");
  return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
}

const defaultFetch: EdgeAwsFetch = (url, init) => fetch(url, init);

/** One read of the store: the signed JSON call, and the value it answers. */
export async function readStoredTokens(source: SsmTokenSource | SecretsManagerTokenSource, now: Date = new Date()): Promise<StoredTokens> {
  const region = source.region ?? "us-east-1";
  const service = source.kind === "ssm" ? "ssm" : "secretsmanager";
  const url = `https://${service}.${region}.amazonaws.com/`;
  const target = source.kind === "ssm" ? "AmazonSSM.GetParameter" : "secretsmanager.GetSecretValue";
  const body = JSON.stringify(source.kind === "ssm" ? { Name: source.name, WithDecryption: true } : { SecretId: source.secretId });
  const credentials = typeof source.credentials === "function" ? await source.credentials() : (source.credentials ?? runtimeCredentials());
  const headers = await signV4Web({ method: "POST", url, headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target }, body, region, service, credentials, now });
  const res = await (source.fetch ?? defaultFetch)(url, { method: "POST", headers, body });
  const text = await res.text();
  const what = source.kind === "ssm" ? `SSM parameter ${source.name}` : `secret ${source.secretId}`;
  if (!res.ok) {
    let type = "";
    try {
      type = String((JSON.parse(text) as { __type?: unknown }).__type ?? "").split("#").pop() ?? "";
    } catch {}
    throw new Error(`reading ${what} in ${region} answered ${res.status}${type ? ` ${type}` : ""}`);
  }
  let value: unknown;
  try {
    const doc = JSON.parse(text) as { Parameter?: { Value?: unknown }; SecretString?: unknown };
    value = source.kind === "ssm" ? doc.Parameter?.Value : doc.SecretString;
  } catch {
    throw new Error(`reading ${what} answered something other than JSON`);
  }
  if (typeof value !== "string") throw new Error(`${what} has no text value${source.kind === "secrets-manager" ? " (a binary secret is not read)" : ""}`);
  const stored = parseStoredTokens(value);
  if (stored.tokens.length === 0) throw new Error(`${what} holds no token`);
  return stored;
}

/** Tokens read from a store and kept for a bounded time. `get` throws while the store cannot be read. */
export interface TokenCache {
  get(): Promise<StoredTokens>;
}

/**
 * A cache over `readStoredTokens`. The first read starts at once (cold
 * start). Requests that arrive during a read wait on that one read. A good
 * read is kept for `cacheSeconds`; a failed one is kept for
 * FAILED_READ_BACKOFF_MS, and every `get` in that time throws. The last good
 * tokens are never served past their time, so the function fails closed.
 */
export function storedTokenCache(source: SsmTokenSource | SecretsManagerTokenSource, now: () => number = Date.now): TokenCache {
  const cacheMs = Math.min(Math.max(source.cacheSeconds ?? DEFAULT_TOKEN_CACHE_SECONDS, 0), MAX_TOKEN_CACHE_SECONDS) * 1000;
  let held: { until: number; result: Promise<StoredTokens> } | undefined;
  const read = (): Promise<StoredTokens> => {
    const result = readStoredTokens(source, new Date(now()));
    const entry = { until: Number.POSITIVE_INFINITY, result };
    held = entry;
    result.then(
      () => {
        entry.until = now() + cacheMs;
      },
      () => {
        entry.until = now() + FAILED_READ_BACKOFF_MS;
      },
    );
    return result;
  };
  read().catch(() => {});
  return {
    get: () => (held && now() < held.until ? held.result : read()),
  };
}
