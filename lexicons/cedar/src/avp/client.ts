/**
 * The AVP read transport (#1652).
 *
 * Amazon Verified Permissions speaks AWS JSON 1.0 — a POST of a JSON body with
 * `x-amz-target: VerifiedPermissions.<Operation>` — so this is the same shape
 * as `lexicons/aws/src/api/read-client.ts`'s Cloud Control half, pointed at a
 * different service. That file is the precedent for the decision this module
 * embodies: **no AWS SDK dependency**. The repo has none anywhere (the aws
 * lexicon's runtime deps are `fflate` and `js-yaml`), and adding
 * `@aws-sdk/client-verifiedpermissions` — 30-odd transitive packages — to the
 * cedar lexicon so that one reader can issue three calls would put an AWS SDK
 * in the dependency tree of a lexicon whose whole premise is that Cedar is
 * vendor-neutral.
 *
 * ## Signing
 *
 * SigV4 lives once, in `lexicons/aws/src/api/sigv4.ts` (#1686). This module
 * does not import it. A cedar → aws dependency edge would make the vendor-
 * neutral lexicon unbuildable without the AWS one, which is the same rule that
 * kept `src/avp/embed.ts` free of the aws lexicon: the seam is the data shape.
 * So the signer arrives as a function on {@link AvpClientOptions}, typed here
 * structurally against what the aws lexicon exports, and a project holding both
 * lexicons wires them in one line:
 *
 * ```ts
 * import { signRequest } from "@intentius/chant-lexicon-aws";
 * import { describeAvpResources } from "@intentius/chant-lexicon-cedar";
 *
 * await describeAvpResources({
 *   environment,
 *   entityNames,
 *   entities,
 *   client: { region: "us-west-2", signer: signRequest },
 * });
 * ```
 *
 * Three cases go out unsigned, byte for byte as they did before signing
 * existed — the credential scope of {@link regionScope} and nothing more:
 *
 *   - **No signer.** The default, and the reason `credentialsAvailable` still
 *     gates the readers: a caller that wires nothing in is still an
 *     emulator-and-test transport, and real AWS still rejects it.
 *   - **No credentials.** A signer with nothing to sign with does not run.
 *   - **An endpoint override.** An emulator does not verify signatures, and
 *     signing against one would make every local lane need credentials to read
 *     what it just deployed. `signEndpointOverride` opts back in for an
 *     override that *is* real AWS — a VPC endpoint, a signing proxy.
 */

const DEFAULT_REGION = "us-east-1";
const TARGET_PREFIX = "VerifiedPermissions";
const SERVICE = "verifiedpermissions";

/** Injectable HTTP, mirroring `AwsReadHttp` in the aws lexicon so tests avoid the network. */
export type AvpHttp = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

const defaultHttp: AvpHttp = async (url, init, signal) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
  return { status: res.status, text: await res.text() };
};

/** A failed AVP read, carrying enough to classify it without matching on prose. */
export class AvpReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The service's own error code (`ResourceNotFoundException`, `AccessDeniedException`, …). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AvpReadError";
  }
}

/**
 * A resolved credential set — the aws lexicon's `AwsCredentials`, restated so
 * that this file compiles without it. `sessionToken` is present for STS/role
 * credentials.
 */
export interface AvpCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A function that decides what to sign with; `undefined` means "nothing to". */
export type AvpCredentialResolver = () => AvpCredentials | undefined;

/** Either literal credentials or a resolver for them. */
export type AvpCredentialSource = AvpCredentials | AvpCredentialResolver;

/** One request to sign — the aws lexicon's `SigV4Request`, restated. */
export interface AvpSignableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: AvpCredentials;
  /** Signing clock. Injected by tests; otherwise now. */
  now?: Date;
}

/**
 * The signing seam. `signRequest` from `@intentius/chant-lexicon-aws` satisfies
 * this as it stands — the shapes above are its own, restated rather than
 * imported, so cedar keeps no edge to the aws lexicon.
 */
export type AvpSigner = (request: AvpSignableRequest) => Record<string, string>;

export interface AvpClientOptions {
  /** Endpoint override (an emulator, or a VPC endpoint). Omit for real AWS hosts. */
  endpoint?: string;
  /** Region for the real-AWS host and the credential scope. */
  region?: string;
  http?: AvpHttp;
  signal?: AbortSignal;
  /** Environment to read credentials from. Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** SigV4, injected. Omitted, every request goes out unsigned as it always did. */
  signer?: AvpSigner;
  /**
   * What to sign with: literal credentials, or a resolver that decides. Omitted,
   * the environment answers; when it has nothing, no signature is produced.
   */
  credentials?: AvpCredentialSource;
  /** Sign even against an endpoint override — for an override that is real AWS. */
  signEndpointOverride?: boolean;
  /** Signing clock. Injected by tests so a signature is reproducible. */
  now?: Date;
}

/**
 * Credentials for a request: explicit → environment → absent.
 *
 * The same rule the aws lexicon's `resolveCredentials` applies, and for the same
 * reasons: an injected resolver is authoritative and its refusal is not
 * second-guessed against the environment, and a half-set environment is absent
 * rather than a signature that cannot verify. A caller with a profile file, IMDS
 * or a container credential endpoint resolves those itself and passes the result
 * in — that is what the resolver form is for.
 */
export function resolveAvpCredentials(
  source?: AvpCredentialSource,
  env: Record<string, string | undefined> = process.env,
): AvpCredentials | undefined {
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

/** Service host for AVP, honouring an endpoint override. */
export function avpUrl(endpoint?: string, region = DEFAULT_REGION): string {
  return `${(endpoint ?? `https://${SERVICE}.${region}.amazonaws.com`).replace(/\/$/, "")}/`;
}

/**
 * Whether this process has anything to authenticate with.
 *
 * An endpoint override counts: an emulator is reached without credentials, and
 * refusing to look at one because `AWS_ACCESS_KEY_ID` is unset would make the
 * local lanes unobservable. Everything else is the ordinary AWS credential
 * surface, minus the instance-metadata path this transport cannot use anyway.
 */
export function credentialsAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env.AWS_ENDPOINT_URL ||
      env.AWS_ACCESS_KEY_ID ||
      env.AWS_PROFILE ||
      env.AWS_SESSION_TOKEN ||
      env.AWS_ROLE_ARN ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE,
  );
}

/**
 * The credential scope header.
 *
 * This is NOT SigV4 — the signature is a placeholder, exactly as in the aws
 * lexicon's read client, and it must not be mistaken for a signed read path. It
 * carries the region so that an endpoint override (one host for every region)
 * still reaches the right one, and it is only ever sent when no signature was
 * produced; the moment one is, {@link requestHeaders} sends that instead.
 */
function regionScope(region: string | undefined, env: Record<string, string | undefined>): Record<string, string> {
  if (!region) return {};
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const key = env.AWS_ACCESS_KEY_ID || "chant";
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${key}/${day}/${region}/${SERVICE}/aws4_request, ` +
      "SignedHeaders=host, Signature=unsigned",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The headers one request goes out with — signed when a signer was injected,
 * something resolved to sign with, and the target is real AWS; scope-only in
 * every other case, which is the path this transport had before signing.
 *
 * Signing needs a region even when the caller named none, because the scope
 * string has a slot for one; it borrows the same default {@link avpUrl} used to
 * build the host, so the signature agrees with the endpoint it is sent to.
 */
function requestHeaders(
  operation: string,
  url: string,
  body: string,
  endpoint: string | undefined,
  options: AvpClientOptions,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const base: Record<string, string> = {
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": `${TARGET_PREFIX}.${operation}`,
  };
  const signer = options.signer;
  const credentials = signer ? resolveAvpCredentials(options.credentials, env) : undefined;
  if (!signer || !credentials || (endpoint && options.signEndpointOverride !== true)) {
    return { ...base, ...regionScope(options.region, env) };
  }
  return signer({
    method: "POST",
    url,
    headers: base,
    body,
    service: SERVICE,
    region: options.region ?? DEFAULT_REGION,
    credentials,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** One AVP call. Throws {@link AvpReadError} carrying the service's `__type`. */
export async function avpCall(
  operation: string,
  payload: Record<string, unknown>,
  options: AvpClientOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const http = options.http ?? defaultHttp;
  const endpoint = options.endpoint ?? env.AWS_ENDPOINT_URL;
  const url = avpUrl(endpoint, options.region);
  const payloadJson = JSON.stringify(payload);
  const res = await http(
    url,
    {
      headers: requestHeaders(operation, url, payloadJson, endpoint, options, env),
      body: payloadJson,
    },
    options.signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new AvpReadError(`unparseable ${operation} response`, res.status);
  }
  const body = isRecord(parsed) ? parsed : {};
  const type = typeof body.__type === "string" ? body.__type.split("#").pop() : undefined;
  if (type || res.status >= 400) {
    const message = typeof body.message === "string" ? body.message : `${operation} failed with HTTP ${res.status}`;
    throw new AvpReadError(message, res.status, type);
  }
  return body;
}

/* ── Shapes ───────────────────────────────────────────────────────────────── */

/** One policy, as `ListPolicies` reports it — no statement, only the description. */
export interface AvpPolicySummary {
  policyStoreId: string;
  policyId: string;
  policyType: string;
  /** `definition.static.description` — the channel chant's marker rides (see ./ownership.ts). */
  description?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
}

/** One policy, as `GetPolicy` reports it — the statement included. */
export interface AvpPolicyDetail extends AvpPolicySummary {
  /** The Cedar policy text. */
  statement: string;
}

function summaryOf(raw: Record<string, unknown>, fallbackStore: string): AvpPolicySummary {
  const definition = isRecord(raw.definition) ? raw.definition : {};
  const staticDef = isRecord(definition.static) ? definition.static : {};
  const description = typeof staticDef.description === "string" ? staticDef.description : undefined;
  return {
    policyStoreId: typeof raw.policyStoreId === "string" ? raw.policyStoreId : fallbackStore,
    policyId: typeof raw.policyId === "string" ? raw.policyId : "",
    policyType: typeof raw.policyType === "string" ? raw.policyType : "STATIC",
    ...(description !== undefined ? { description } : {}),
    ...(typeof raw.createdDate === "string" ? { createdDate: raw.createdDate } : {}),
    ...(typeof raw.lastUpdatedDate === "string" ? { lastUpdatedDate: raw.lastUpdatedDate } : {}),
  };
}

/** `ListPolicies` for one store, paginated to exhaustion. */
export async function listPolicies(
  policyStoreId: string,
  options: AvpClientOptions = {},
): Promise<AvpPolicySummary[]> {
  const out: AvpPolicySummary[] = [];
  let nextToken: string | undefined;
  do {
    const body = await avpCall(
      "ListPolicies",
      { policyStoreId, ...(nextToken ? { nextToken } : {}) },
      options,
    );
    const rows = Array.isArray(body.policies) ? body.policies : [];
    for (const row of rows) {
      if (isRecord(row)) out.push(summaryOf(row, policyStoreId));
    }
    nextToken = typeof body.nextToken === "string" && body.nextToken.length > 0 ? body.nextToken : undefined;
  } while (nextToken);
  return out;
}

/**
 * `GetPolicy` — the full record for one policy, statement included.
 *
 * A template-linked policy has no `definition.static`, so its statement comes
 * back empty; callers treat an empty statement as "not a static policy this
 * lexicon authored" rather than as a parse failure.
 */
export async function getPolicy(
  policyStoreId: string,
  policyId: string,
  options: AvpClientOptions = {},
): Promise<AvpPolicyDetail> {
  const body = await avpCall("GetPolicy", { policyStoreId, policyId }, options);
  const definition = isRecord(body.definition) ? body.definition : {};
  const staticDef = isRecord(definition.static) ? definition.static : {};
  return {
    ...summaryOf(body, policyStoreId),
    policyId: typeof body.policyId === "string" ? body.policyId : policyId,
    statement: typeof staticDef.statement === "string" ? staticDef.statement : "",
  };
}

/** One policy store, as `GetPolicyStore` reports it. */
export interface AvpPolicyStore {
  policyStoreId: string;
  arn?: string;
  description?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
}

/** `GetPolicyStore` — used to resolve the store ARN the tag read needs. */
export async function getPolicyStore(
  policyStoreId: string,
  options: AvpClientOptions = {},
): Promise<AvpPolicyStore> {
  const body = await avpCall("GetPolicyStore", { policyStoreId }, options);
  return {
    policyStoreId: typeof body.policyStoreId === "string" ? body.policyStoreId : policyStoreId,
    ...(typeof body.arn === "string" ? { arn: body.arn } : {}),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(typeof body.createdDate === "string" ? { createdDate: body.createdDate } : {}),
    ...(typeof body.lastUpdatedDate === "string" ? { lastUpdatedDate: body.lastUpdatedDate } : {}),
  };
}

/** `ListTagsForResource` — the store-level half of the ownership channel. */
export async function listStoreTags(
  resourceArn: string,
  options: AvpClientOptions = {},
): Promise<Record<string, string>> {
  const body = await avpCall("ListTagsForResource", { resourceArn }, options);
  const tags = isRecord(body.tags) ? body.tags : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/* ── Classification ───────────────────────────────────────────────────────── */

/** True when the failure means the store itself is not there. */
export function storeDoesNotExist(err: unknown): boolean {
  if (!(err instanceof AvpReadError)) return false;
  return err.code === "ResourceNotFoundException" || /not\s*found|does not exist/i.test(err.message);
}

const CREDENTIAL_PATTERN =
  /credential|token|expired|AccessDenied|not authorized|Unauthorized|UnrecognizedClient|InvalidSignature/i;

/**
 * Map a transport failure onto the closed {@link UnobservedReason} set.
 *
 * Anything that is not demonstrably a credential problem is `read-failed`,
 * because guessing wider would let a throttle or a DNS failure masquerade as a
 * verdict about the estate.
 */
export function classifyAvpFailure(err: unknown): { reason: "no-credentials" | "read-failed"; detail: string } {
  const code = err instanceof AvpReadError && err.code ? `${err.code}: ` : "";
  const message = err instanceof Error ? err.message : String(err);
  const detail = `${code}${message}`;
  return {
    reason: CREDENTIAL_PATTERN.test(detail) ? "no-credentials" : "read-failed",
    detail,
  };
}

/**
 * The address a read was issued against, for the observation's `queried` map
 * (chant #1620).
 *
 * An absence is only as trustworthy as the address behind it, and an AVP read
 * has three ways to be pointed at the wrong place: the region, the store id,
 * and the `@id` annotation the policy is matched on. All three are in here.
 */
export function policyAddress(policyStoreId: string, cedarPolicyId: string, region?: string): string {
  return `avp://${region ?? DEFAULT_REGION}/policy-store/${policyStoreId}/policy?@id=${encodeURIComponent(cedarPolicyId)}`;
}

/** The address of the store-wide enumeration itself. */
export function storeAddress(policyStoreId: string, region?: string): string {
  return `avp://${region ?? DEFAULT_REGION}/policy-store/${policyStoreId}/policies`;
}
