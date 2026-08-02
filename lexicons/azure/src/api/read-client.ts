/**
 * The native Azure read transport (#1212) — the read half of what
 * `op/activities/az-apply.ts` already does for writes.
 *
 * Azure's observers shelled `az resource show`, once per declared entity,
 * serially, and read the failure out of the CLI's stderr. The applier does
 * not: `azApply` PUTs each resource at its ARM URL over `fetch`, honours an
 * endpoint override, and is injectable for tests. Since `az resource show`
 * returns the ARM JSON that endpoint would have returned anyway, this is
 * transport only — the payload the readers normalize is unchanged, which is
 * what made Azure the cheapest of the three observers to move.
 *
 * ## Signing
 *
 * Requests are unsigned, exactly like `azApply`'s. That is what makes the
 * emulator lane work with no credential plumbing, and the reason this is
 * scoped to floci-az rather than announced as a real-ARM read path: real ARM
 * wants a bearer token. The `az` CLI path remains for a signed read until
 * token acquisition lands here.
 */

import { type AzHttp } from "../op/activities/az-apply";

/** Default ARM host, matching the applier's. */
const DEFAULT_ENDPOINT = "https://management.azure.com";
/** floci-az's fixed local subscription, matching the applier's. */
const DEFAULT_SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
/** Generic ARM resource read, adequate for every top-level type chant declares. */
const DEFAULT_API_VERSION = "2021-04-01";

export interface AzureReadClientOptions {
  /** Endpoint override (floci-az `http://localhost:4577`). Omit for real ARM. */
  endpoint?: string;
  subscriptionId?: string;
  /** Resource group the environment maps to. */
  resourceGroup: string;
  http?: AzHttp;
  signal?: AbortSignal;
}

/** A failed read, carrying the status and ARM's own error code where it sent one. */
export class AzureReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AzureReadError";
  }
}

/** True when the read failed only because the resource is not there. */
export function isNotFound(err: unknown): boolean {
  return err instanceof AzureReadError && err.status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultHttp: AzHttp = async (method, url, body, signal) => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return { status: res.status, text: await res.text() };
};

/** The ARM URL for one resource in the group — the same shape the applier PUTs to. */
export function armResourceReadUrl(
  options: AzureReadClientOptions,
  type: string,
  name: string,
  apiVersion = DEFAULT_API_VERSION,
): string {
  const base = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const subscription = options.subscriptionId ?? DEFAULT_SUBSCRIPTION;
  return `${base}/subscriptions/${subscription}/resourceGroups/${options.resourceGroup}/providers/${type}/${name}?api-version=${apiVersion}`;
}

/**
 * ARM's error envelope is `{ error: { code, message } }`. Reading the code
 * rather than the prose is the point of moving off the CLI: `ResourceNotFound`
 * is a fact, "(ResourceNotFound) The Resource … was not found" is a sentence
 * that changes between CLI versions.
 */
function readError(status: number, text: string): AzureReadError {
  let code: string | undefined;
  let message = `ARM read failed with HTTP ${status}`;
  try {
    const body: unknown = JSON.parse(text);
    const error = isRecord(body) ? body.error : undefined;
    if (isRecord(error)) {
      if (typeof error.code === "string") code = error.code;
      if (typeof error.message === "string") message = error.message;
    }
  } catch {
    // A non-JSON body from a proxy or a gateway — the status is all there is.
  }
  return new AzureReadError(message, status, code);
}

/** One resource as ARM returns it. */
export interface ArmResourceBody {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  tags?: Record<string, string>;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** GET one resource. Throws {@link AzureReadError}; 404 means absent, which callers check with {@link isNotFound}. */
export async function getResource(
  options: AzureReadClientOptions,
  type: string,
  name: string,
  apiVersion?: string,
): Promise<ArmResourceBody> {
  const http = options.http ?? defaultHttp;
  const url = armResourceReadUrl(options, type, name, apiVersion);
  const res = await http("GET", url, undefined, options.signal);
  if (res.status >= 300) throw readError(res.status, res.text);
  try {
    const body: unknown = JSON.parse(res.text);
    if (!isRecord(body)) throw new AzureReadError(`unparseable ARM body for ${type}/${name}`, res.status);
    return body as ArmResourceBody;
  } catch (err) {
    if (err instanceof AzureReadError) throw err;
    throw new AzureReadError(`unparseable ARM body for ${type}/${name}`, res.status);
  }
}
