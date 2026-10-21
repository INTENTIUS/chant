/**
 * Runtime health for GCP (#4177): Cloud Run services.
 *
 * A Cloud Run v2 service carries its `Ready` condition as `terminalCondition`
 * (`CONDITION_SUCCEEDED`, `CONDITION_FAILED`, pending or reconciling). The v1
 * and Config Connector shape carries it in `status.conditions` with
 * `status: "True" | "False" | "Unknown"`; both are read. Same transport,
 * project resolution and endpoint rule as `describe-resources.ts`, so
 * `GCP_ENDPOINT_URL` (floci-gcp) answers.
 */

import type { HealthEntry, HealthReadOptions, HealthReadResult, UnobservedEntity } from "@intentius/chant/lexicon";
import { getResource, GcpReadError, isNotFound, type GcpReadHttp } from "./api/read-client";
import { deriveGVK, manifestProjectAnnotations, resolveReadProject } from "./describe-resources";

export const GCP_HEALTH_TYPES = ["GCP::Run::Service"] as const;

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

export async function observeHealthGcp(options: GcpHealthOptions): Promise<HealthReadResult> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const endpoint = process.env.GCP_ENDPOINT_URL;
  const manifestProjects = manifestProjectAnnotations(options.buildOutput);
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absent: string[] = [];

  await Promise.all(
    [...options.entities].map(async ([entityName, { entityType, props }]) => {
      const gvk = deriveGVK(entityType);
      const metadata = props.metadata as { name?: string; annotations?: Record<string, string> } | undefined;
      const name = metadata?.name;
      if (!gvk || !name) {
        unobserved[entityName] = {
          type: entityType,
          reason: "read-failed",
          detail: gvk ? "declared entity has no metadata.name to query by" : `cannot derive a GCP kind from ${entityType}`,
        };
        return;
      }
      let project: string;
      try {
        project = resolveReadProject(gvk.kind, name, metadata, manifestProjects);
      } catch (err) {
        unobserved[entityName] = { type: entityType, reason: "no-binding", detail: err instanceof Error ? err.message : String(err) };
        return;
      }
      try {
        const body = await getResource(
          { project, ...(endpoint ? { endpoint } : {}), ...(options.http ? { http: options.http } : {}) },
          gvk.kind,
          name,
          props,
        );
        entities[entityName] = cloudRunEntry(body as CloudRunServiceState, observedAt);
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
