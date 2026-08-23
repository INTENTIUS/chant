/**
 * The native AWS read transport (#1206) — the read half of what
 * `op/activities/aws-apply.ts` already does for writes.
 *
 * Every AWS observer shelled `aws …` once per entity, serially, and parsed
 * stderr to find out what went wrong (#1085). The applier does not: `awsApply`
 * speaks the CloudFormation Query protocol over `fetch`, honours an endpoint
 * override, and is injectable for tests. This module is that same transport
 * pointed at the two APIs the read path needs:
 *
 *   - **CloudFormation Query** (form-encoded POST, XML back) — the stack reads
 *     `describeResources` and the deep pass both start from.
 *   - **Cloud Control** (AWS JSON 1.0, `X-Amz-Target: CloudApiService.*`) — the
 *     property-level reads (#1015).
 *
 * Both take the endpoint the same way the applier does, so `chant emulator` /
 * behold `--local` keep working by construction rather than by each observer
 * remembering to inject `--endpoint-url`.
 *
 * ## Signing
 *
 * Requests are signed with SigV4 (#1686) when credentials resolve — see
 * `./sigv4.ts`, which holds the implementation so that cedar's AVP client can
 * adopt the same one rather than growing a second. Two cases stay unsigned, and
 * both are deliberate:
 *
 *   - **No credentials.** The caller's existing no-credentials path is
 *     untouched: the request still goes out carrying only the credential scope
 *     of {@link regionScope}, which is what the emulator lanes have always
 *     sent.
 *   - **An endpoint override.** Floci does not verify signatures, and signing
 *     against it would mean every local lane suddenly needs credentials to read
 *     what it just deployed. `signEndpointOverride` opts back in for an
 *     override that *is* real AWS — a VPC endpoint, a signing proxy.
 *
 * What counts as an override is one rule, {@link resolveEndpointOverride}: the
 * `endpoint` option, else the ambient `AWS_ENDPOINT_URL_<SERVICE>` the AWS SDK
 * honours per service, else `AWS_ENDPOINT_URL` (#1694). Cedar's AVP client
 * (`lexicons/cedar/src/avp/client.ts`) applies the same rule; it restates it
 * rather than importing it, because cedar does not depend on this lexicon and
 * a lexicon build compiles against the published core, so a helper hoisted
 * into core would not be visible to either until the next core release.
 */
import { resolveCredentials, signRequest, type AwsCredentialSource } from "./sigv4";

export type { AwsCredentials, AwsCredentialResolver, AwsCredentialSource } from "./sigv4";

const DEFAULT_REGION = "us-east-1";
const CFN_API_VERSION = "2010-05-15";
const CLOUD_CONTROL_TARGET_PREFIX = "CloudApiService";

/** Injectable HTTP, mirroring `AwsHttp` in the applier so tests avoid the network. */
export type AwsReadHttp = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

const defaultHttp: AwsReadHttp = async (url, init, signal) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
  return { status: res.status, text: await res.text() };
};

/** A failed read, carrying enough to classify it without parsing prose. */
export class AwsReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The API's own error code (`ValidationError`, `UnsupportedOperation`, …) when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AwsReadError";
  }
}

export interface AwsReadClientOptions {
  /**
   * Endpoint override (Floci `http://localhost:4566`). Omitted, the environment
   * answers through {@link resolveEndpointOverride}; when it names nothing
   * either, the target is the real AWS host.
   */
  endpoint?: string;
  /** Region for the real-AWS host and the Query `Version` context. */
  region?: string;
  http?: AwsReadHttp;
  signal?: AbortSignal;
  /**
   * What to sign with: literal credentials, or a resolver that decides. Omitted,
   * the environment answers; when it has nothing, the request goes out unsigned
   * exactly as it did before signing existed.
   */
  credentials?: AwsCredentialSource;
  /** Environment the credential fallback reads. Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Sign even against an endpoint override — for an override that is real AWS. */
  signEndpointOverride?: boolean;
  /** Signing clock. Injected by tests so a signature is reproducible. */
  now?: Date;
}

/**
 * The SDK's per-service endpoint variable for a signing-service name:
 * `AWS_ENDPOINT_URL_<SERVICE ID>`, the service id upper-cased with every
 * non-alphanumeric run replaced by `_`. The SDK keys that by the service id of
 * its model, which is the signing name for every service here except Cloud
 * Control (`cloudcontrolapi` signs, `CloudControl` is the id).
 */
const ENV_SERVICE_ID: Record<string, string> = { cloudcontrolapi: "cloudcontrol" };

/** The name of the service-specific endpoint variable the AWS SDK reads for `service`. */
export function serviceEndpointEnvVar(service: string): string {
  const id = ENV_SERVICE_ID[service] ?? service;
  return `AWS_ENDPOINT_URL_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The one rule for what an endpoint override is (#1694): the `endpoint` option
 * when given, else the service-specific `AWS_ENDPOINT_URL_<SERVICE>`, else the
 * ambient `AWS_ENDPOINT_URL` — the same precedence the AWS SDK applies. The
 * result is the target the request goes to and, through {@link requestHeaders},
 * the fact that decides whether it is signed. Returns `undefined` for real AWS.
 */
export function resolveEndpointOverride(
  service: string,
  endpoint: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return endpoint || env[serviceEndpointEnvVar(service)] || env.AWS_ENDPOINT_URL || undefined;
}

/**
 * `options` with its endpoint settled by {@link resolveEndpointOverride}, so
 * the URL builder and the signing decision read the same answer.
 */
export function withEndpointOverride(service: string, options: AwsReadClientOptions): AwsReadClientOptions {
  const endpoint = resolveEndpointOverride(service, options.endpoint, options.env ?? process.env);
  return endpoint ? { ...options, endpoint } : options;
}

/** Service host for `service`, honouring an endpoint override. */
export function serviceUrl(service: string, endpoint?: string, region = DEFAULT_REGION): string {
  return `${(endpoint ?? `https://${service}.${region}.amazonaws.com`).replace(/\/$/, "")}/`;
}

/**
 * How the request says which region it is for.
 *
 * Against real AWS the region is the hostname, which is why `serviceUrl` takes
 * it. Against an endpoint override there is only one host for every region, so
 * the hostname carries nothing and the region has to travel in the request —
 * and every emulator reads it where a real SDK puts it, in the credential scope
 * of the `Authorization` header.
 *
 * Without this, a stack observed with `region: "us-west-1"` was read against
 * whatever region the emulator defaults to. The result is not an error: the
 * stack genuinely does not exist in us-east-1, so `describeResources` returned
 * an empty observation and the snapshot recorded the region as holding nothing.
 * A three-region estate snapshotted as one region and nothing said so.
 *
 * This is NOT SigV4. The signature is a placeholder and real AWS rejects it. It
 * is what an unsigned request still has to carry so an emulator learns the
 * region, and it is only ever sent when no credentials resolved — the moment
 * they do, {@link requestHeaders} sends a real signature instead.
 */
function regionScope(
  service: string,
  region: string | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (!region) return {};
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const key = env.AWS_ACCESS_KEY_ID || "chant";
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${key}/${day}/${region}/${service}/aws4_request, ` +
      "SignedHeaders=host, Signature=unsigned",
  };
}

/**
 * The headers one request goes out with — signed when there is something to
 * sign with and the target is real AWS, scope-only otherwise.
 *
 * Signing needs a region even when the caller named none, because the scope
 * string has a slot for one; it borrows the same `us-east-1` default that
 * {@link serviceUrl} already used to build the host, so the signature agrees
 * with the endpoint it is sent to.
 *
 * Exported because this decision — sign, or carry the scope and no signature —
 * belongs to the lexicon's read transport rather than to any one API on it.
 * `agentcore/trace-fetch.ts` reads `bedrock-agentcore` through the same seam,
 * and a second copy of this would be a second place for the emulator carve-out
 * to drift.
 *
 * Callers pass options already settled by {@link withEndpointOverride}, so an
 * override the environment named is skipped exactly like one the option did.
 */
export function requestHeaders(
  service: string,
  url: string,
  body: string,
  base: Record<string, string>,
  options: AwsReadClientOptions,
): Record<string, string> {
  const env = options.env ?? process.env;
  const credentials = resolveCredentials(options.credentials, env);
  const signable = credentials && (!options.endpoint || options.signEndpointOverride === true);
  if (!signable) return { ...base, ...regionScope(service, options.region, env) };
  return signRequest({
    method: "POST",
    url,
    headers: base,
    body,
    service,
    region: options.region ?? DEFAULT_REGION,
    credentials,
    ...(options.now ? { now: options.now } : {}),
  });
}

/* ── CloudFormation Query ─────────────────────────────────────────────────── */

/**
 * The `<Tag>text</Tag>` pairs of one XML fragment, as a flat record. Repeated
 * tags keep the first occurrence, which is what a `<member>` body wants —
 * nested lists inside a member are not modelled, because nothing the read path
 * needs from `DescribeStackResources` / `DescribeStacks` is nested that deep.
 */
export function xmlLeaves(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fragment.matchAll(/<([A-Za-z0-9]+)>([^<]*)<\/\1>/g)) {
    const [, tag, value] = m;
    if (tag && !(tag in out)) out[tag] = decodeXmlEntities(value ?? "");
  }
  return out;
}

/** The five predefined XML entities. Query responses carry them in ARNs and policy text. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Every `<member>…</member>` under `listTag`, each flattened by
 * {@link xmlLeaves}. The Query protocol renders a list as repeated `<member>`
 * elements, and `xmlField` in the applier deliberately does not handle them —
 * it was written for scalar status fields.
 */
export function xmlMembers(xml: string, listTag: string): Array<Record<string, string>> {
  const list = xml.match(new RegExp(`<${listTag}>([\\s\\S]*?)</${listTag}>`))?.[1];
  if (!list) return [];
  return [...list.matchAll(/<member>([\s\S]*?)<\/member>/g)].map((m) => xmlLeaves(m[1] ?? ""));
}

/** `<Error><Code>…</Code><Message>…</Message></Error>`, when the response carries one. */
export function xmlError(xml: string): { code?: string; message?: string } | undefined {
  if (!/<Error>/.test(xml)) return undefined;
  const leaves = xmlLeaves(xml.match(/<Error>([\s\S]*?)<\/Error>/)?.[1] ?? "");
  return { code: leaves.Code, message: leaves.Message };
}

/**
 * One CloudFormation Query call. Returns the raw XML; throws
 * {@link AwsReadError} for a non-2xx or an `<Error>` body, so a caller
 * classifies a typed failure instead of matching on stderr.
 */
export async function cfnQuery(
  action: string,
  params: Record<string, string>,
  options: AwsReadClientOptions = {},
): Promise<string> {
  options = withEndpointOverride("cloudformation", options);
  const http = options.http ?? defaultHttp;
  const url = serviceUrl("cloudformation", options.endpoint, options.region);
  const body = new URLSearchParams({ Action: action, Version: CFN_API_VERSION, ...params }).toString();
  const res = await http(
    url,
    {
      headers: requestHeaders(
        "cloudformation",
        url,
        body,
        { "content-type": "application/x-www-form-urlencoded" },
        options,
      ),
      body,
    },
    options.signal,
  );
  const err = xmlError(res.text);
  if (err || res.status >= 400) {
    throw new AwsReadError(
      err?.message ?? `${action} failed with HTTP ${res.status}`,
      res.status,
      err?.code,
    );
  }
  return res.text;
}

/** One stack resource, as `DescribeStackResources` reports it. */
export interface StackResource {
  logicalId: string;
  type: string;
  physicalId?: string;
  status?: string;
  timestamp?: string;
}

/** `DescribeStackResources` for one stack, mapped off the Query XML. */
export async function describeStackResources(
  stackName: string,
  options: AwsReadClientOptions = {},
): Promise<StackResource[]> {
  const xml = await cfnQuery("DescribeStackResources", { StackName: stackName }, options);
  return xmlMembers(xml, "StackResources").map((m) => ({
    logicalId: m.LogicalResourceId ?? "",
    type: m.ResourceType ?? "",
    ...(m.PhysicalResourceId ? { physicalId: m.PhysicalResourceId } : {}),
    ...(m.ResourceStatus ? { status: m.ResourceStatus } : {}),
    ...(m.Timestamp ? { timestamp: m.Timestamp } : {}),
  }));
}

/** `DescribeStacks` outputs for one stack, as `key → value`. */
export async function describeStackOutputs(
  stackName: string,
  options: AwsReadClientOptions = {},
): Promise<Record<string, string>> {
  const xml = await cfnQuery("DescribeStacks", { StackName: stackName }, options);
  const outputs: Record<string, string> = {};
  for (const m of xmlMembers(xml, "Outputs")) {
    if (m.OutputKey) outputs[m.OutputKey] = m.OutputValue ?? "";
  }
  return outputs;
}

/* ── Cloud Control ────────────────────────────────────────────────────────── */

/** One live resource, as Cloud Control describes it. */
export interface CloudControlDescription {
  identifier: string;
  properties: Record<string, unknown>;
}

/**
 * One Cloud Control call (AWS JSON 1.0). Throws {@link AwsReadError} carrying
 * the service's `__type` so `UnsupportedOperation` — what Floci answers for
 * `GetResource` — stays distinguishable from a credential or a genuine miss.
 */
async function cloudControl(
  operation: "GetResource" | "ListResources",
  payload: Record<string, unknown>,
  options: AwsReadClientOptions = {},
): Promise<Record<string, unknown>> {
  options = withEndpointOverride("cloudcontrolapi", options);
  const http = options.http ?? defaultHttp;
  const url = serviceUrl("cloudcontrolapi", options.endpoint, options.region);
  const payloadJson = JSON.stringify(payload);
  const res = await http(
    url,
    {
      headers: requestHeaders(
        "cloudcontrolapi",
        url,
        payloadJson,
        {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `${CLOUD_CONTROL_TARGET_PREFIX}.${operation}`,
        },
        options,
      ),
      body: payloadJson,
    },
    options.signal,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new AwsReadError(`unparseable ${operation} response`, res.status);
  }
  const body = isRecord(parsed) ? parsed : {};
  const type = typeof body.__type === "string" ? body.__type.split("#").pop() : undefined;
  if (type || res.status >= 400) {
    const message = typeof body.message === "string" ? body.message : `${operation} failed with HTTP ${res.status}`;
    throw new AwsReadError(message, res.status, type);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cloud Control returns a resource model as a JSON *string* inside the
 * envelope, so every description unwraps twice. Returns null when either level
 * does not parse to an object — an unparseable body is a failed read, not an
 * empty resource.
 */
export function parseResourceDescription(raw: unknown): CloudControlDescription | null {
  if (!isRecord(raw)) return null;
  const properties = typeof raw.Properties === "string" ? safeParseObject(raw.Properties) : undefined;
  if (!properties) return null;
  return {
    identifier: typeof raw.Identifier === "string" ? raw.Identifier : "",
    properties,
  };
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `GetResource` — the full live model for one identifier. */
export async function getResource(
  typeName: string,
  identifier: string,
  options: AwsReadClientOptions = {},
): Promise<CloudControlDescription | null> {
  const body = await cloudControl("GetResource", { TypeName: typeName, Identifier: identifier }, options);
  return parseResourceDescription(body.ResourceDescription);
}

/** `ListResources` — every live resource of one type, paginated to exhaustion. */
export async function listResources(
  typeName: string,
  options: AwsReadClientOptions = {},
): Promise<CloudControlDescription[]> {
  const out: CloudControlDescription[] = [];
  let nextToken: string | undefined;
  do {
    const body = await cloudControl(
      "ListResources",
      { TypeName: typeName, ...(nextToken ? { NextToken: nextToken } : {}) },
      options,
    );
    const descriptions = Array.isArray(body.ResourceDescriptions) ? body.ResourceDescriptions : [];
    for (const d of descriptions) {
      const parsed = parseResourceDescription(d);
      if (parsed) out.push(parsed);
    }
    nextToken = typeof body.NextToken === "string" && body.NextToken.length > 0 ? body.NextToken : undefined;
  } while (nextToken);
  return out;
}
