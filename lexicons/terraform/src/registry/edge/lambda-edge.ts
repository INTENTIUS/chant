/**
 * The registry edge function as a Lambda@Edge origin-request handler on
 * CloudFront (chant#4566), Node 20 or later. Lambda@Edge has no environment
 * variables, so the options are fixed when the function is built:
 *
 *   export const handler = lambdaEdgeHandler({ files: originFiles("https://<bucket endpoint>"), auth: { tokens: [...] } });
 *
 * A request the gate refuses gets the 401 from the function. A download gets
 * its answer, with `X-Terraform-Get` and, with auth on, a signed tarball URL.
 * Every other request goes on to the bucket, without the query string when
 * auth is on. CloudFront must pass
 * the query string and the Authorization header to the function (an origin
 * request policy) for the token check and signed URLs to work.
 *
 * A CloudFront Function cannot read the bucket's `download` body, so it
 * cannot add the header; this needs Lambda@Edge.
 *
 * The accepted tokens come from `auth.source` (chant#4590): built into the
 * zip as `auth.tokens` (`{ kind: "zip" }`, the default), or read from SSM
 * Parameter Store or Secrets Manager at cold start and kept for a bounded
 * time (./token-source.ts):
 *
 *   lambdaEdgeHandler({ files, auth: { source: { kind: "ssm", name: "/registry/tokens", region: "us-east-1" } } });
 *
 * While a store read fails, every request gets a 503.
 */
import { registryEdgeGate, type EdgeAuth, type RegistryEdgeOptions } from "./edge";
import { storedTokenCache, type EdgeTokenSource, type StoredTokens } from "./token-source";

/** The parts of a CloudFront request event this handler reads. */
export interface CloudFrontRequest {
  uri: string;
  querystring?: string;
  method: string;
  headers: Record<string, { key?: string; value: string }[]>;
}

export interface CloudFrontRequestEvent {
  Records: { cf: { config?: { distributionDomainName?: string }; request: CloudFrontRequest } }[];
}

/** A response Lambda@Edge generates in place of the origin's. */
export interface CloudFrontResponse {
  status: string;
  statusDescription?: string;
  headers: Record<string, { key: string; value: string }[]>;
  body?: string;
}

/** The web Request a CloudFront request stands for. */
export function requestFromCloudFront(event: CloudFrontRequestEvent): Request {
  const { config, request } = event.Records[0]!.cf;
  const host = request.headers.host?.[0]?.value ?? config?.distributionDomainName ?? "localhost";
  const headers = new Headers();
  for (const values of Object.values(request.headers)) for (const h of values) if (h.key) headers.append(h.key, h.value);
  return new Request(`https://${host}${request.uri}${request.querystring ? `?${request.querystring}` : ""}`, { method: request.method, headers });
}

/** A web Response as a Lambda@Edge generated response. */
export async function responseToCloudFront(res: Response): Promise<CloudFrontResponse> {
  const headers: CloudFrontResponse["headers"] = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = [{ key, value }];
  });
  const body = res.body ? await res.text() : undefined;
  return { status: String(res.status), headers, ...(body !== undefined ? { body } : {}) };
}

/** Read auth on Lambda@Edge: `EdgeAuth`, with the tokens from `source`. */
export interface LambdaEdgeAuth extends Omit<EdgeAuth, "tokens"> {
  /** The tokens built into the function, for `source` zip (the default). Ignored with a store source. */
  tokens?: string[];
  /** Where the tokens come from. Default `{ kind: "zip" }`. */
  source?: EdgeTokenSource;
}

export interface LambdaEdgeOptions extends Omit<RegistryEdgeOptions, "auth"> {
  /** Read auth. Absent (the default) means anyone who can reach the host reads. */
  auth?: LambdaEdgeAuth;
}

/** The answer while the token store cannot be read: the function fails closed, and CloudFront does not cache it. */
const storeUnavailable = (): CloudFrontResponse => ({
  status: "503",
  statusDescription: "Service Unavailable",
  headers: { "content-type": [{ key: "Content-Type", value: "application/json" }], "cache-control": [{ key: "Cache-Control", value: "no-store" }] },
  body: `${JSON.stringify({ errors: ["the registry cannot check tokens right now"] })}\n`,
});

/** An origin-request handler: a generated response, or the request passed on to the bucket. */
export function lambdaEdgeHandler(options: LambdaEdgeOptions): (event: CloudFrontRequestEvent) => Promise<CloudFrontRequest | CloudFrontResponse> {
  const { auth, ...rest } = options;
  const source = auth?.source ?? { kind: "zip" };
  const passOn = (event: CloudFrontRequestEvent): CloudFrontRequest => {
    // The signature has been checked; the bucket gets the plain object key, so its own query auth never sees ours.
    const request = event.Records[0]!.cf.request;
    return auth ? { ...request, querystring: "" } : request;
  };
  const edgeAuth = (tokens: string[], signingKey?: string): EdgeAuth => ({
    tokens,
    // A signing key kept in the store rotates with it, so it comes before one built into the zip.
    ...(signingKey || auth?.signingKey ? { signingKey: signingKey || auth?.signingKey } : {}),
    ...(auth?.ttl !== undefined ? { ttl: auth.ttl } : {}),
  });
  if (!auth || source.kind === "zip") {
    const gate = registryEdgeGate({ ...rest, ...(auth ? { auth: edgeAuth(auth.tokens ?? []) } : {}) });
    return async (event) => {
      const answer = await gate(requestFromCloudFront(event));
      return answer ? responseToCloudFront(answer) : passOn(event);
    };
  }
  const cache = storedTokenCache(source, rest.now);
  // One gate per read, so a request between rotations is checked against one consistent token set.
  let gateFor: { stored: StoredTokens; gate: ReturnType<typeof registryEdgeGate> } | undefined;
  return async (event) => {
    let stored: StoredTokens;
    try {
      stored = await cache.get();
    } catch (e) {
      rest.log?.(`token store: ${(e as Error).message}`);
      return storeUnavailable();
    }
    if (gateFor?.stored !== stored) gateFor = { stored, gate: registryEdgeGate({ ...rest, auth: edgeAuth(stored.tokens, stored.signingKey) }) };
    const answer = await gateFor.gate(requestFromCloudFront(event));
    return answer ? responseToCloudFront(answer) : passOn(event);
  };
}
