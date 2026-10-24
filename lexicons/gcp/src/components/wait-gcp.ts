/**
 * wait / verify family, gcp members (#3143): `wait-for-operation` (a
 * `google.longrunning` operation reaches `done`) and `wait-cloud-run-ready` (a
 * Cloud Run service serves its latest revision). Both poll the REST API on an
 * injectable `http`, so a test or floci-gcp swaps the transport. A wait is a
 * read-only observation: neither declares a rollback.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { GcpReadError, getResource, isNotFound, type GcpReadHttp } from "../api/read-client";
import { NO_PROJECT, resolveGcpEndpoint } from "../op/activities/gcp-apply";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface GcpWaitOptions {
  http?: GcpReadHttp;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const realHttp: GcpReadHttp = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
};

interface PollInput {
  /** Endpoint for the API, such as floci-gcp's. Default: `GCP_ENDPOINT_URL`, else the real host. */
  endpoint?: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
  /** Overall timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
}

// ── wait-for-operation ───────────────────────────────────────────────────────

export interface WaitForOperationInput extends PollInput {
  /** The operation's full URL (`https://run.googleapis.com/v2/projects/p/locations/l/operations/op`), or its name when `endpoint` or `GCP_ENDPOINT_URL` gives the host. */
  operation: string;
}

export interface WaitForOperationOutput {
  /** The finished operation's `response`, when it has one. */
  response?: unknown;
}

/** Poll an operation until `done: true`. An operation that finishes with an `error` throws its message. */
export function createWaitForOperationCapability(
  options: GcpWaitOptions = {},
): Capability<WaitForOperationInput, WaitForOperationOutput> {
  const http = options.http ?? realHttp;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  return {
    kind: "wait-for-operation",
    async run(_ctx, input) {
      let url = input.operation;
      if (!/^https?:\/\//.test(url)) {
        const host = resolveGcpEndpoint(input);
        if (!host) throw new Error(`wait-for-operation "${input.operation}": a bare operation name needs "endpoint" or GCP_ENDPOINT_URL`);
        url = `${host.replace(/\/$/, "")}/v2/${url.replace(/^\//, "")}`;
      }
      const interval = input.intervalMs ?? DEFAULT_INTERVAL_MS;
      const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (true) {
        const res = await http("GET", url);
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`wait-for-operation: GET ${url} failed with ${res.status}: ${res.text.slice(0, 200)}`);
        }
        const body = JSON.parse(res.text) as { done?: boolean; error?: { message?: string }; response?: unknown };
        if (body.done === true) {
          if (body.error) throw new Error(`wait-for-operation: operation failed: ${body.error.message ?? "unknown error"}`);
          return { ...(body.response !== undefined ? { response: body.response } : {}) };
        }
        if (now() > deadline) throw new Error(`wait-for-operation "${input.operation}" timed out before the operation finished`);
        await sleep(interval);
      }
    },
  };
}

export const waitForOperationCapability: Capability<WaitForOperationInput, WaitForOperationOutput> =
  createWaitForOperationCapability();

// ── wait-cloud-run-ready ─────────────────────────────────────────────────────

export interface WaitCloudRunReadyInput extends PollInput {
  /** The Cloud Run service's name. */
  service: string;
  /** Region of the service. Default: `us-central1`, the applier's default. */
  location?: string;
  /** Project. Default: `GCP_PROJECT_ID`, else `GOOGLE_CLOUD_PROJECT`. */
  project?: string;
}

export interface WaitCloudRunReadyOutput {
  /** The revision serving traffic once the service is steady. */
  revision: string;
  /** The service URL, once it has one. */
  uri?: string;
}

/**
 * Poll a Cloud Run v2 service until its terminal condition succeeded, nothing
 * is reconciling, and the latest created revision is the latest ready one.
 */
export function createWaitCloudRunReadyCapability(
  options: GcpWaitOptions = {},
): Capability<WaitCloudRunReadyInput, WaitCloudRunReadyOutput> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  return {
    kind: "wait-cloud-run-ready",
    async run(_ctx, input) {
      const project = input.project ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error(NO_PROJECT);
      const endpoint = resolveGcpEndpoint(input);
      const client = { project, ...(endpoint ? { endpoint } : {}), ...(options.http ? { http: options.http } : {}) };
      const declared = { spec: { location: input.location ?? "us-central1" } };
      const interval = input.intervalMs ?? DEFAULT_INTERVAL_MS;
      const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (true) {
        let state = "NOT_FOUND";
        try {
          const svc = (await getResource(client, "RunService", input.service, declared)) as {
            terminalCondition?: { state?: string; message?: string };
            reconciling?: boolean;
            latestCreatedRevision?: string;
            latestReadyRevision?: string;
            uri?: string;
          };
          state = svc.terminalCondition?.state ?? "CONDITION_UNKNOWN";
          if (state === "CONDITION_FAILED") {
            throw new Error(`wait-cloud-run-ready "${input.service}" failed: ${svc.terminalCondition?.message ?? state}`);
          }
          const revision = svc.latestReadyRevision ?? "";
          if (state === "CONDITION_SUCCEEDED" && svc.reconciling !== true && revision && revision === (svc.latestCreatedRevision ?? revision)) {
            return { revision, ...(svc.uri ? { uri: svc.uri } : {}) };
          }
        } catch (err) {
          if (!(err instanceof GcpReadError) || !isNotFound(err)) throw err;
        }
        if (now() > deadline) throw new Error(`wait-cloud-run-ready "${input.service}" timed out in state ${state}`);
        await sleep(interval);
      }
    },
  };
}

export const waitCloudRunReadyCapability: Capability<WaitCloudRunReadyInput, WaitCloudRunReadyOutput> =
  createWaitCloudRunReadyCapability();
