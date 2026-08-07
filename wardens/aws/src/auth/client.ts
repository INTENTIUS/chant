/**
 * AWS API client for the governance surface: Organizations and CloudTrail.
 *
 * Both are x-amz-json-1.1 RPC services: POST to the service root with an
 * `X-Amz-Target` action header. Signed with the local SigV4 signer; no
 * @aws-sdk/* dependency. `endpointUrl` (or AWS_ENDPOINT_URL) points the
 * client at an emulator (floci) — same override the AWS CLI honours.
 *
 * The `request(service, action, body)` shape plays the role the REST
 * `request(method, path, body)` plays in the SCM warden clients.
 */

import { signRequest, type Sigv4Credentials } from "./sigv4.js";

export class AwsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    /** The AWS error type, e.g. "PolicyNotFoundException". */
    public readonly errorType?: string,
  ) {
    super(message);
    this.name = "AwsApiError";
  }
}

export type AwsService = "organizations" | "cloudtrail";

/** JSON-RPC target prefixes per service. */
const TARGETS: Record<AwsService, string> = {
  organizations: "AWSOrganizationsV20161128",
  cloudtrail: "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101",
};

export interface AwsClientOptions {
  credentials: Sigv4Credentials;
  /** Region for regional services (cloudtrail). Default "us-east-1". */
  region?: string;
  /** Emulator/base endpoint override (floci: "http://localhost:4566"). */
  endpointUrl?: string;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AwsClient {
  /** Signed x-amz-json-1.1 call. Returns the parsed JSON response body. */
  request<T = unknown>(service: AwsService, action: string, body?: Record<string, unknown>): Promise<T>;
  /**
   * Collect every page of a list call: follows `NextToken`, concatenating
   * `pick(page)` across pages.
   */
  paginate<T>(
    service: AwsService,
    action: string,
    body: Record<string, unknown>,
    pick: (page: Record<string, unknown>) => T[] | undefined,
  ): Promise<T[]>;
}

function endpointFor(service: AwsService, region: string, override?: string): URL {
  if (override) return new URL(override);
  // Organizations is a global service homed in us-east-1.
  const host =
    service === "organizations" ? "organizations.us-east-1.amazonaws.com" : `${service}.${region}.amazonaws.com`;
  return new URL(`https://${host}/`);
}

export function createClient(opts: AwsClientOptions): AwsClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const region = opts.region ?? "us-east-1";

  async function request<T>(service: AwsService, action: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = endpointFor(service, region, opts.endpointUrl);
    const payload = JSON.stringify(body);
    const headers = signRequest({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `${TARGETS[service]}.${action}`,
      },
      body: payload,
      service,
      // Sign for the service's home region: global Organizations is us-east-1.
      region: service === "organizations" ? "us-east-1" : region,
      credentials: opts.credentials,
    });

    const res = await doFetch(url, { method: "POST", headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      let type: string | undefined;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
        type = parsed.__type?.split("#").pop();
        message = parsed.message ?? parsed.Message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new AwsApiError(`${action} failed (${res.status}${type ? ` ${type}` : ""}): ${message}`, res.status, type);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function paginate<T>(
    service: AwsService,
    action: string,
    body: Record<string, unknown>,
    pick: (page: Record<string, unknown>) => T[] | undefined,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const page = await request<Record<string, unknown>>(service, action, {
        ...body,
        ...(token ? { NextToken: token } : {}),
      });
      out.push(...(pick(page) ?? []));
      token = page.NextToken as string | undefined;
    } while (token);
    return out;
  }

  return { request, paginate };
}

/** Credentials + endpoint from the environment (AWS_* — same vars the CLI uses). */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): AwsClientOptions {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials required: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  }
  return {
    credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN },
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    endpointUrl: env.AWS_ENDPOINT_URL,
  };
}
