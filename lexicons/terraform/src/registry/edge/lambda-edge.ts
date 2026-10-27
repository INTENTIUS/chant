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
 */
import { registryEdgeGate, type RegistryEdgeOptions } from "./edge";

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

/** An origin-request handler: a generated response, or the request passed on to the bucket. */
export function lambdaEdgeHandler(options: RegistryEdgeOptions): (event: CloudFrontRequestEvent) => Promise<CloudFrontRequest | CloudFrontResponse> {
  const gate = registryEdgeGate(options);
  return async (event) => {
    const answer = await gate(requestFromCloudFront(event));
    if (answer) return responseToCloudFront(answer);
    // The signature has been checked; the bucket gets the plain object key, so its own query auth never sees ours.
    const request = event.Records[0]!.cf.request;
    return options.auth ? { ...request, querystring: "" } : request;
  };
}
