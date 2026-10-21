/**
 * Runtime health for Azure (#4177): Container Apps.
 *
 * For each declared `Microsoft.App/containerApps`, GET the app (a 404 is
 * absent), then its revisions, and judge the active ones by their running and
 * health state. Same transport and endpoint rule as `describe-resources.ts`, so
 * `AZURE_ENDPOINT_URL` (floci-az) answers.
 *
 * When the revisions list cannot be read but the app carries a
 * `runningStatus` (newer API versions do), that answers instead, and the detail
 * says so.
 */

import type { HealthEntry, HealthReadOptions, HealthReadResult, UnobservedEntity } from "@intentius/chant/lexicon";
import { armResourceReadUrl, AzureReadError, getResource, isNotFound, type AzureReadClientOptions } from "./api/read-client";
import { classifyArmFailure } from "./describe-resources";
import type { AzHttp } from "./op/activities/az-apply";

export const AZURE_HEALTH_TYPES = ["Microsoft.App/containerApps"] as const;

/** The Container Apps API version whose revisions carry `runningState` and `healthState`. */
const CONTAINER_APPS_API_VERSION = "2024-03-01";

export interface AzureHealthOptions extends HealthReadOptions {
  http?: AzHttp;
  now?: () => Date;
}

/** The fields of one revision that decide health. */
export interface RevisionState {
  name?: string;
  properties?: {
    active?: boolean;
    runningState?: string;
    healthState?: string;
    replicas?: number;
    trafficWeight?: number;
    lastActiveTime?: string;
    createdTime?: string;
  };
}

const RUNNING = new Set(["running", "runningatmaxscale"]);
const DOWN = new Set(["failed", "degraded", "stopped"]);

/**
 * The active revisions' verdict: unhealthy if none is active or any active one
 * failed, degraded, stopped or reports `Unhealthy`; healthy if every active one
 * is running and none is unhealthy; otherwise unknown (still provisioning).
 */
export function containerAppEntry(revisions: RevisionState[], observedAt: string): HealthEntry {
  const type = "Microsoft.App/containerApps";
  const active = revisions.filter((r) => r.properties?.active === true);
  if (active.length === 0) {
    return { type, state: "unhealthy", detail: `no active revision (${revisions.length} revision(s))`, observedAt };
  }
  const describe = (r: RevisionState): string => {
    const p = r.properties ?? {};
    const bits = [p.runningState ?? "no running state"];
    if (p.healthState && p.healthState !== "None") bits.push(p.healthState);
    if (typeof p.replicas === "number") bits.push(`${p.replicas} replica(s)`);
    if (typeof p.trafficWeight === "number") bits.push(`${p.trafficWeight}% traffic`);
    return `${r.name ?? "revision"} ${bits.join(", ")}`;
  };
  const detail = active.map(describe).join("; ");
  const running = (r: RevisionState) => RUNNING.has((r.properties?.runningState ?? "").toLowerCase());
  const down = (r: RevisionState) =>
    DOWN.has((r.properties?.runningState ?? "").toLowerCase()) || r.properties?.healthState?.toLowerCase() === "unhealthy";
  const checkedAt = active
    .map((r) => r.properties?.lastActiveTime ?? r.properties?.createdTime)
    .filter((t): t is string => typeof t === "string")
    .sort()
    .pop();
  const state = active.some(down) ? "unhealthy" : active.every(running) ? "healthy" : "unknown";
  return { type, state, detail, observedAt, ...(checkedAt ? { checkedAt } : {}) };
}

/** An app's own `runningStatus`, for when its revisions cannot be listed. */
export function appRunningStatusEntry(runningStatus: string, observedAt: string): HealthEntry {
  const lower = runningStatus.toLowerCase();
  const state = RUNNING.has(lower) ? "healthy" : DOWN.has(lower) ? "unhealthy" : "unknown";
  return {
    type: "Microsoft.App/containerApps",
    state,
    detail: `app runningStatus ${runningStatus} (revisions not readable)`,
    observedAt,
  };
}

function hole(err: unknown): UnobservedEntity {
  const { reason, detail } = classifyArmFailure(err);
  return { type: "Microsoft.App/containerApps", reason, detail };
}

async function listRevisions(client: AzureReadClientOptions, name: string): Promise<RevisionState[]> {
  const http = client.http!;
  const url = armResourceReadUrl(client, "Microsoft.App/containerApps", `${name}/revisions`, CONTAINER_APPS_API_VERSION);
  const res = await http("GET", url, undefined, client.signal);
  if (res.status >= 300) throw new AzureReadError(`revisions read failed with HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new AzureReadError("unparseable revisions list", res.status);
  }
  const value = body && typeof body === "object" ? (body as { value?: unknown }).value : undefined;
  if (!Array.isArray(value)) throw new AzureReadError("unparseable revisions list", res.status);
  return value as RevisionState[];
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

export async function observeHealthAzure(options: AzureHealthOptions): Promise<HealthReadResult> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const client: AzureReadClientOptions = {
    resourceGroup: options.environment,
    ...(process.env.AZURE_ENDPOINT_URL ? { endpoint: process.env.AZURE_ENDPOINT_URL } : {}),
    ...(process.env.AZURE_SUBSCRIPTION_ID ? { subscriptionId: process.env.AZURE_SUBSCRIPTION_ID } : {}),
    http: options.http ?? defaultHttp,
  };
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];

  await Promise.all(
    [...options.entities].map(async ([entityName, { entityType, props }]) => {
      const name = props.name as string | undefined;
      if (!name) {
        unobserved[entityName] = { type: entityType, reason: "read-failed", detail: "declared entity has no name to query by" };
        return;
      }
      let app: Awaited<ReturnType<typeof getResource>>;
      try {
        app = await getResource(client, entityType, name, CONTAINER_APPS_API_VERSION);
      } catch (err) {
        if (isNotFound(err)) absent.push(entityName);
        else unobserved[entityName] = hole(err);
        return;
      }
      try {
        entities[entityName] = containerAppEntry(await listRevisions(client, name), observedAt);
      } catch (err) {
        const runningStatus = app.properties?.runningStatus;
        if (typeof runningStatus === "string" && runningStatus.length > 0) {
          entities[entityName] = appRunningStatusEntry(runningStatus, observedAt);
        } else {
          unobserved[entityName] = hole(err);
        }
      }
    }),
  );

  return { entities, unobserved, absent };
}
