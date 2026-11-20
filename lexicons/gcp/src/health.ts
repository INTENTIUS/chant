/**
 * Runtime health for GCP (#4177): Cloud Run services; and (#4239) backend
 * services, from `getHealth` on each backend group, and IAM policy members,
 * healthy when the member holds the role in the target's policy.
 *
 * A Cloud Run v2 service carries its `Ready` condition as `terminalCondition`
 * (`CONDITION_SUCCEEDED`, `CONDITION_FAILED`, pending or reconciling). The v1
 * and Config Connector shape carries it in `status.conditions` with
 * `status: "True" | "False" | "Unknown"`; both are read. Same transport,
 * project resolution and endpoint rule as `describe-resources.ts`, so
 * `GCP_ENDPOINT_URL` (floci-gcp) answers.
 *
 * A terraform root's or pulumi stack's resources come with
 * `options.physicalIds` (#5338), the ids the google provider records, and
 * {@link gcpTargetFromId} reads the project, location and name out of each
 * in place of the declared spec:
 *
 * | type | recorded id |
 * |---|---|
 * | `GCP::Run::Service` | `projects/<p>/locations/<l>/services/<n>` (v2), `locations/<l>/namespaces/<p>/services/<n>` (v1) |
 * | `GCP::Compute::BackendService` | `projects/<p>/global/backendServices/<n>`, `projects/<p>/regions/<r>/backendServices/<n>` |
 * | `GCP::Iam::PolicyMember` | `<p>/<role>/<member>`, a project IAM member |
 */

import type { HealthEntry, HealthReadOptions, HealthReadResult, UnobservedEntity } from "@intentius/chant/lexicon";
import { getResource, GcpReadError, isNotFound, readUrl, type GcpReadHttp } from "./api/read-client";
import { deriveGVK, manifestProjectAnnotations, readManifest, readTargets, resolveReadProject } from "./describe-resources";

export const GCP_HEALTH_TYPES = ["GCP::Run::Service", "GCP::Compute::BackendService", "GCP::Iam::PolicyMember"] as const;

export interface GcpHealthOptions extends HealthReadOptions {
  http?: GcpReadHttp;
  now?: () => Date;
}

interface Condition {
  type?: string;
  state?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** The parts of a Cloud Run service body that decide health. */
export interface CloudRunServiceState {
  terminalCondition?: Condition;
  conditions?: Condition[];
  reconciling?: boolean;
  latestReadyRevision?: string;
  uri?: string;
  status?: { conditions?: Condition[]; url?: string };
}

function readyCondition(body: CloudRunServiceState): Condition | undefined {
  if (body.terminalCondition && (body.terminalCondition.type ?? "Ready") === "Ready") return body.terminalCondition;
  return body.conditions?.find((c) => c.type === "Ready") ?? body.status?.conditions?.find((c) => c.type === "Ready");
}

/** The `Ready` condition's verdict. No condition at all is `unknown`. */
export function cloudRunEntry(body: CloudRunServiceState, observedAt: string): HealthEntry {
  const type = "GCP::Run::Service";
  const ready = readyCondition(body);
  if (!ready) return { type, state: "unknown", detail: "no Ready condition", observedAt };
  const value = (ready.state ?? ready.status ?? "").toUpperCase();
  const state =
    value === "CONDITION_SUCCEEDED" || value === "TRUE"
      ? "healthy"
      : value === "CONDITION_FAILED" || value === "FALSE"
        ? "unhealthy"
        : "unknown";
  const why = ready.message || ready.reason;
  const revision = body.latestReadyRevision ? `, latest ready ${body.latestReadyRevision.split("/").pop()}` : "";
  const reconciling = body.reconciling ? ", reconciling" : "";
  return {
    type,
    state,
    detail: `Ready ${ready.state ?? ready.status ?? "unset"}${why ? `: ${why}` : ""}${revision}${reconciling}`,
    observedAt,
    ...(ready.lastTransitionTime ? { checkedAt: ready.lastTransitionTime } : {}),
  };
}

/** One backend group's `getHealth` answer: `healthStatus[].healthState` per endpoint. */
export interface BackendGroupHealth {
  group: string;
  healthStatus?: Array<{ healthState?: string }>;
  /** Set when the call failed; the group then counts as unknown. */
  error?: string;
}

/**
 * A backend service's verdict from its groups: any endpoint `UNHEALTHY` is
 * unhealthy; every endpoint `HEALTHY`, with at least one, is healthy; anything
 * else (no backends, a group that reports no status, as a serverless NEG
 * does, a failed call) is unknown.
 */
export function backendServiceEntry(groups: readonly BackendGroupHealth[], observedAt: string): HealthEntry {
  const type = "GCP::Compute::BackendService";
  if (groups.length === 0) return { type, state: "unknown", detail: "no backends", observedAt };
  let healthy = 0;
  let unhealthy = 0;
  let unknown = 0;
  for (const g of groups) {
    const states = g.error ? [] : (g.healthStatus ?? []).map((h) => (h.healthState ?? "").toUpperCase());
    if (states.length === 0) unknown++;
    else if (states.some((st) => st === "UNHEALTHY")) unhealthy++;
    else if (states.every((st) => st === "HEALTHY")) healthy++;
    else unknown++;
  }
  const state = unhealthy > 0 ? "unhealthy" : healthy === groups.length ? "healthy" : "unknown";
  const parts = [`${healthy} of ${groups.length} backend${groups.length === 1 ? "" : "s"} healthy`];
  if (unhealthy) parts.push(`${unhealthy} unhealthy`);
  if (unknown) parts.push(`${unknown} with no health status`);
  return { type, state, detail: parts.join(", "), observedAt };
}

/** A binding the read found in its target's policy. A missing one is `absent`, never here. */
export function policyMemberEntry(binding: { role?: string; member?: string; resource?: string }, observedAt: string): HealthEntry {
  return {
    type: "GCP::Iam::PolicyMember",
    state: "healthy",
    detail: `${binding.member ?? "member"} holds ${binding.role ?? "the role"}${binding.resource ? ` on ${binding.resource}` : ""}`,
    observedAt,
  };
}

/** What a read needs of one resource: its name, project and a declared spec the REST mapper builds the URL from. */
export interface GcpIdTarget {
  name: string;
  project: string;
  props: Record<string, unknown>;
}

/**
 * The read target an engine's recorded id names (#5338), or undefined when
 * the id has none of the shapes in the module doc. A full `selfLink` URL is
 * read as its path.
 */
export function gcpTargetFromId(entityType: string, id: string): GcpIdTarget | undefined {
  const path = id.trim().replace(/^https:\/\/[^/]+\/(?:compute\/v1\/|v[12]\/)?/, "");
  let m: RegExpExecArray | null;
  switch (entityType) {
    case "GCP::Run::Service":
      if ((m = /^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/.exec(path))) {
        return { project: m[1]!, name: m[3]!, props: { spec: { location: m[2]! } } };
      }
      if ((m = /^locations\/([^/]+)\/namespaces\/([^/]+)\/services\/([^/]+)$/.exec(path))) {
        return { project: m[2]!, name: m[3]!, props: { spec: { location: m[1]! } } };
      }
      return undefined;
    case "GCP::Compute::BackendService":
      if ((m = /^projects\/([^/]+)\/global\/backendServices\/([^/]+)$/.exec(path))) {
        return { project: m[1]!, name: m[2]!, props: { spec: { location: "global" } } };
      }
      if ((m = /^projects\/([^/]+)\/regions\/([^/]+)\/backendServices\/([^/]+)$/.exec(path))) {
        return { project: m[1]!, name: m[3]!, props: { spec: { location: m[2]! } } };
      }
      return undefined;
    case "GCP::Iam::PolicyMember": {
      // `<project>/<role>/<member>`. A role is `roles/<r>` or
      // `projects/<p>/roles/<r>`; the member is the first segment after it
      // that carries a `type:` prefix, to the end.
      const parts = path.split("/");
      const at = parts.findIndex((seg, i) => i >= 2 && /^[a-zA-Z]+:/.test(seg));
      if (parts.length < 3 || at === -1) return undefined;
      const project = parts[0]!;
      const role = parts.slice(1, at).join("/");
      const member = parts.slice(at).join("/");
      if (!/^(?:roles|projects\/[^/]+\/roles|organizations\/[^/]+\/roles)\/[^/]+$/.test(role)) return undefined;
      return {
        project,
        name: `${role}/${member}`,
        props: { spec: { member, role, resourceRef: { kind: "Project", external: `projects/${project}` } } },
      };
    }
    default:
      return undefined;
  }
}

const defaultReadHttp: GcpReadHttp = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
};

/** `getHealth` for each of a backend service's groups, at the service's own read URL. */
async function backendGroupsHealth(url: string, body: Record<string, unknown>, http: GcpReadHttp): Promise<BackendGroupHealth[]> {
  const backends = Array.isArray(body.backends) ? (body.backends as Array<{ group?: unknown }>) : [];
  return Promise.all(
    backends
      .map((b) => b.group)
      .filter((g): g is string => typeof g === "string")
      .map(async (group) => {
        try {
          const res = await http("POST", `${url}/getHealth`, { group });
          if (res.status < 200 || res.status >= 300) return { group, error: `getHealth ${res.status}` };
          return { group, ...(JSON.parse(res.text) as { healthStatus?: Array<{ healthState?: string }> }) };
        } catch (err) {
          return { group, error: err instanceof Error ? err.message : String(err) };
        }
      }),
  );
}

export async function observeHealthGcp(options: GcpHealthOptions): Promise<HealthReadResult> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const endpoint = process.env.GCP_ENDPOINT_URL;
  const manifestProjects = manifestProjectAnnotations(options.buildOutput);
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];
  const recorded = options.physicalIds;
  const targets = recorded ? new Map<string, { name: string; props: Record<string, unknown> }>() : readTargets(options.entities);
  const manifest = recorded ? [] : readManifest(options.entities, targets);

  await Promise.all(
    [...options.entities].map(async ([entityName, { entityType }]) => {
      const gvk = deriveGVK(entityType);
      if (!gvk) {
        unobserved[entityName] = { type: entityType, reason: "read-failed", detail: `cannot derive a GCP kind from ${entityType}` };
        return;
      }
      let name: string;
      let props: Record<string, unknown>;
      let project: string;
      if (recorded) {
        const id = recorded[entityName];
        if (!id) {
          absent.push(entityName);
          return;
        }
        const target = gcpTargetFromId(entityType, id);
        if (!target) {
          unobserved[entityName] = { type: entityType, reason: "read-failed", detail: `recorded id ${id} names no ${entityType} chant can read` };
          return;
        }
        ({ name, props, project } = target);
      } else {
        ({ name, props } = targets.get(entityName)!);
        const metadata = props.metadata as { annotations?: Record<string, string> } | undefined;
        try {
          project = resolveReadProject(gvk.kind, name, metadata, manifestProjects, props);
        } catch (err) {
          unobserved[entityName] = { type: entityType, reason: "no-binding", detail: err instanceof Error ? err.message : String(err) };
          return;
        }
      }
      try {
        const client = { project, ...(endpoint ? { endpoint } : {}), ...(options.http ? { http: options.http } : {}), manifest };
        const body = await getResource(client, gvk.kind, name, props);
        if (gvk.kind === "ComputeBackendService") {
          const groups = await backendGroupsHealth(readUrl(client, gvk.kind, name, props), body, options.http ?? defaultReadHttp);
          entities[entityName] = backendServiceEntry(groups, observedAt);
        } else if (gvk.kind === "IAMPolicyMember") {
          entities[entityName] = policyMemberEntry(body as { role?: string; member?: string; resource?: string }, observedAt);
        } else {
          entities[entityName] = cloudRunEntry(body as CloudRunServiceState, observedAt);
        }
      } catch (err) {
        if (isNotFound(err)) {
          absent.push(entityName);
          return;
        }
        const status = err instanceof GcpReadError ? err.status : undefined;
        unobserved[entityName] = {
          type: entityType,
          reason: status === 401 || status === 403 ? "no-credentials" : "read-failed",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        };
      }
    }),
  );

  return { entities, unobserved, absent };
}
