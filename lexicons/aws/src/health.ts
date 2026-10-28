/**
 * Runtime health for AWS (#4177): Route 53 health checks and ECS services.
 *
 * The stack's own resource list maps each logical id (the graph's node id) to
 * the physical id the health APIs take. A stack that does not exist yet means
 * nothing is deployed, so every entity is absent. Any other stack failure is a
 * hole for every entity, never `unhealthy`.
 *
 * - `AWS::Route53::HealthCheck`: `GetHealthCheckStatus`, aggregated as Route 53
 *   does: healthy when more than 18% of the checkers report healthy.
 * - `AWS::ECS::Service`: `DescribeServices`, `runningCount` against
 *   `desiredCount`.
 *
 * Both go through the read transport's endpoint rule, so `AWS_ENDPOINT_URL`
 * (Floci) answers them.
 */

import type { HealthEntry, HealthReadOptions, HealthReadResult, UnobservedEntity } from "@intentius/chant/lexicon";
import {
  AwsReadError,
  describeStackResources,
  requestHeaders,
  serviceUrl,
  withChainCredentials,
  withEndpointOverride,
  xmlError,
  xmlLeaves,
  type AwsReadClientOptions,
} from "./api/read-client";
import { resolveCredentials, signRequest } from "./api/signing";
import { stackDoesNotExist } from "./stack-errors";

export const AWS_HEALTH_TYPES = ["AWS::Route53::HealthCheck", "AWS::ECS::Service"] as const;

/** Injectable HTTP for both calls, so tests never reach the network. */
export type AwsHealthHttp = (
  method: "GET" | "POST",
  url: string,
  init: { headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: string }>;

const defaultHttp: AwsHealthHttp = async (method, url, init) => {
  const res = await fetch(url, { method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  return { status: res.status, text: await res.text() };
};

export interface AwsHealthOptions extends HealthReadOptions {
  http?: AwsHealthHttp;
  /** Read client for the stack list and the signing decision. Tests inject `http` and `env` here. */
  client?: AwsReadClientOptions;
  now?: () => Date;
}

/** Route 53 treats an endpoint as healthy when more than this share of checkers says so. */
const ROUTE53_HEALTHY_SHARE = 0.18;

/** One checker's report, as `GetHealthCheckStatus` returns it. */
export interface CheckerObservation {
  region?: string;
  ipAddress?: string;
  status: string;
  checkedTime?: string;
}

/** Parse `GetHealthCheckStatusResponse`'s observations. */
export function parseHealthCheckStatus(xml: string): CheckerObservation[] {
  const out: CheckerObservation[] = [];
  for (const m of xml.matchAll(/<HealthCheckObservation>([\s\S]*?)<\/HealthCheckObservation>/g)) {
    const body = m[1] ?? "";
    const report = xmlLeaves(body.match(/<StatusReport>([\s\S]*?)<\/StatusReport>/)?.[1] ?? "");
    const top = xmlLeaves(body.replace(/<StatusReport>[\s\S]*?<\/StatusReport>/, ""));
    out.push({
      ...(top.Region ? { region: top.Region } : {}),
      ...(top.IPAddress ? { ipAddress: top.IPAddress } : {}),
      status: report.Status ?? "",
      ...(report.CheckedTime ? { checkedTime: report.CheckedTime } : {}),
    });
  }
  return out;
}

/** A checker's status text starts with `Success` when it found the endpoint healthy. */
function checkerHealthy(o: CheckerObservation): boolean {
  return /^success/i.test(o.status.trim());
}

/** Route 53's verdict over its checkers' observations. */
export function healthCheckEntry(observations: CheckerObservation[], observedAt: string): HealthEntry {
  const type = "AWS::Route53::HealthCheck";
  if (observations.length === 0) {
    return { type, state: "unknown", detail: "no checker has reported yet", observedAt };
  }
  const healthy = observations.filter(checkerHealthy).length;
  const latest = [...observations].sort((a, b) => (b.checkedTime ?? "").localeCompare(a.checkedTime ?? ""))[0]!;
  const state = healthy / observations.length > ROUTE53_HEALTHY_SHARE ? "healthy" : "unhealthy";
  return {
    type,
    state,
    detail: `${healthy}/${observations.length} checkers healthy; last: ${latest.status}`,
    observedAt,
    ...(latest.checkedTime ? { checkedAt: latest.checkedTime } : {}),
  };
}

/** The parts of an ECS service `DescribeServices` returns that decide health. */
export interface EcsServiceState {
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  deployments?: Array<{ rolloutState?: string; updatedAt?: number | string }>;
}

/** Running against desired. Scaled to zero is `unknown`: nothing is serving, by choice. */
export function ecsServiceEntry(service: EcsServiceState, observedAt: string): HealthEntry {
  const type = "AWS::ECS::Service";
  const desired = service.desiredCount ?? 0;
  const running = service.runningCount ?? 0;
  const pending = service.pendingCount ?? 0;
  const counts = `${running}/${desired} running${pending > 0 ? `, ${pending} pending` : ""}`;
  const rollout = service.deployments?.find((d) => d.rolloutState)?.rolloutState;
  const detail = `${counts}${rollout ? `, rollout ${rollout}` : ""}`;
  if (service.status && service.status !== "ACTIVE") {
    return { type, state: "unhealthy", detail: `service is ${service.status}; ${detail}`, observedAt };
  }
  if (desired === 0) return { type, state: "unknown", detail: `desired count is 0; ${detail}`, observedAt };
  return { type, state: running >= desired ? "healthy" : "unhealthy", detail, observedAt };
}

/** The cluster a service ARN names: `service/<cluster>/<name>`, or the default cluster for the old `service/<name>` form. */
export function clusterOfServiceArn(arn: string): string {
  const resource = arn.split(":").slice(5).join(":");
  const parts = resource.split("/");
  return parts.length >= 3 ? parts[1]! : "default";
}

function holeFrom(type: string, err: unknown): UnobservedEntity {
  const detail = err instanceof AwsReadError && err.code ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  const reason = /credential|token|expired|AccessDenied|not authorized|Unauthorized/i.test(detail) ? "no-credentials" : "read-failed";
  return { type, reason, detail: detail.slice(0, 200) };
}

async function getHealthCheckStatus(
  id: string,
  client: AwsReadClientOptions,
  http: AwsHealthHttp,
): Promise<CheckerObservation[]> {
  const options = await withChainCredentials(withEndpointOverride("route53", client));
  // Route 53 is global: one host, signed in us-east-1.
  const base = (options.endpoint ?? "https://route53.amazonaws.com").replace(/\/$/, "");
  const url = `${base}/2013-04-01/healthcheck/${encodeURIComponent(id)}/status`;
  const env = options.env ?? process.env;
  const credentials = resolveCredentials(options.credentials, env);
  const signable = credentials && (!options.endpoint || options.signEndpointOverride === true);
  const headers = signable
    ? signRequest({ method: "GET", url, headers: {}, body: "", service: "route53", region: "us-east-1", credentials, ...(options.now ? { now: options.now } : {}) })
    : {};
  const res = await http("GET", url, { headers });
  const err = xmlError(res.text);
  if (err || res.status >= 400) {
    throw new AwsReadError(err?.message ?? `GetHealthCheckStatus failed with HTTP ${res.status}`, res.status, err?.code);
  }
  return parseHealthCheckStatus(res.text);
}

async function describeServices(
  cluster: string,
  arns: string[],
  client: AwsReadClientOptions,
  http: AwsHealthHttp,
): Promise<{ services: Array<EcsServiceState & { serviceArn?: string }>; failures: Array<{ arn?: string; reason?: string }> }> {
  const options = await withChainCredentials(withEndpointOverride("ecs", client));
  const url = serviceUrl("ecs", options.endpoint, options.region);
  const body = JSON.stringify({ cluster, services: arns });
  const headers = requestHeaders(
    "ecs",
    url,
    body,
    { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonEC2ContainerServiceV20141113.DescribeServices" },
    options,
  );
  const res = await http("POST", url, { headers, body });
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(res.text);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    throw new AwsReadError("unparseable DescribeServices response", res.status);
  }
  const errType = typeof parsed.__type === "string" ? parsed.__type.split("#").pop() : undefined;
  if (errType || res.status >= 400) {
    const message = typeof parsed.message === "string" ? parsed.message : `DescribeServices failed with HTTP ${res.status}`;
    throw new AwsReadError(message, res.status, errType);
  }
  return {
    services: Array.isArray(parsed.services) ? (parsed.services as Array<EcsServiceState & { serviceArn?: string }>) : [],
    failures: Array.isArray(parsed.failures) ? (parsed.failures as Array<{ arn?: string; reason?: string }>) : [],
  };
}

export async function observeHealthAws(options: AwsHealthOptions): Promise<HealthReadResult> {
  const http = options.http ?? defaultHttp;
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const client: AwsReadClientOptions = { ...(options.client ?? {}), ...(options.region ? { region: options.region } : {}) };
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];
  if (options.entities.size === 0) return { entities, unobserved, absent };

  const stackName = options.stack ?? options.environment;
  let physical: Map<string, string>;
  try {
    const resources = await describeStackResources(stackName, client);
    physical = new Map(resources.filter((r) => r.physicalId).map((r) => [r.logicalId, r.physicalId!]));
  } catch (err) {
    if (err instanceof AwsReadError && stackDoesNotExist(err.message)) return { entities, unobserved, absent: [...options.entities.keys()] };
    for (const [name, { entityType }] of options.entities) {
      unobserved[name] = holeFrom(entityType, err);
      unobserved[name]!.detail = `DescribeStackResources failed for stack "${stackName}": ${unobserved[name]!.detail}`;
    }
    return { entities, unobserved, absent };
  }

  const services = new Map<string, Array<{ name: string; arn: string }>>();
  const checks: Array<{ name: string; id: string }> = [];
  for (const [name, { entityType }] of options.entities) {
    const id = physical.get(name);
    if (!id) {
      absent.push(name);
      continue;
    }
    if (entityType === "AWS::ECS::Service") {
      const cluster = clusterOfServiceArn(id);
      const list = services.get(cluster) ?? [];
      list.push({ name, arn: id });
      services.set(cluster, list);
    } else if (entityType === "AWS::Route53::HealthCheck") {
      checks.push({ name, id });
    }
  }

  await Promise.all(
    checks.map(async ({ name, id }) => {
      try {
        entities[name] = healthCheckEntry(await getHealthCheckStatus(id, client, http), observedAt);
      } catch (err) {
        if (err instanceof AwsReadError && err.code === "NoSuchHealthCheck") absent.push(name);
        else unobserved[name] = holeFrom("AWS::Route53::HealthCheck", err);
      }
    }),
  );

  await Promise.all(
    [...services].map(async ([cluster, members]) => {
      // DescribeServices takes at most ten services per call.
      for (let i = 0; i < members.length; i += 10) {
        const batch = members.slice(i, i + 10);
        try {
          const { services: found, failures } = await describeServices(cluster, batch.map((m) => m.arn), client, http);
          for (const member of batch) {
            const service = found.find((s) => s.serviceArn === member.arn || s.serviceArn?.endsWith(`/${member.arn.split("/").pop()}`));
            const failure = failures.find((f) => f.arn === member.arn);
            if (service) entities[member.name] = ecsServiceEntry(service, observedAt);
            else if (failure?.reason === "MISSING") absent.push(member.name);
            else {
              unobserved[member.name] = {
                type: "AWS::ECS::Service",
                reason: "read-failed",
                detail: failure?.reason ? `DescribeServices: ${failure.reason}` : "DescribeServices did not return the service",
              };
            }
          }
        } catch (err) {
          for (const member of batch) unobserved[member.name] = holeFrom("AWS::ECS::Service", err);
        }
      }
    }),
  );

  return { entities, unobserved, absent };
}
