import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
import { safeHeartbeat } from "./heartbeat";

const PROJECT_ID_ANNOTATION = "cnrm.cloud.google.com/project-id";

/** Minimal shape of a serialized CNRM resource (`*.cnrm.cloud.google.com`). */
export interface GcpResource {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
}

/** A CNRM StorageBucket (`storage.cnrm.cloud.google.com`). */
export interface CnrmStorageBucket extends GcpResource {
  spec?: {
    location?: string;
    storageClass?: string;
    uniformBucketLevelAccess?: boolean;
    versioning?: { enabled?: boolean };
    lifecycleRule?: Array<{ action?: Record<string, unknown>; condition?: Record<string, unknown> }>;
  };
}

/** GCS Buckets:insert request body (the subset chant emits). */
export interface BucketInsertBody {
  name: string;
  location?: string;
  storageClass?: string;
  iamConfiguration?: { uniformBucketLevelAccess: { enabled: boolean } };
  versioning?: { enabled: boolean };
  lifecycle?: { rule: Array<{ action: Record<string, unknown>; condition?: Record<string, unknown> }> };
}

/** Pub/Sub Topic resource body (subset). */
export interface PubSubTopicBody {
  labels?: Record<string, string>;
  messageRetentionDuration?: string;
}

// ── Resource mappers (kind → REST) ────────────────────────────────────────────

/** One HTTP plan: an idempotency `GET` (200 = exists) and the create request. */
export interface ApplyPlan {
  getUrl: string;
  create: { method: "POST" | "PUT"; url: string; body: unknown };
}

/** Maps one CNRM kind to its GCP REST operations. The unit of the dispatch table. */
export interface ResourceMapper {
  /** CNRM kind this handles. */
  kind: string;
  /** Real-GCP API host, used when no `endpoint` override is given. */
  defaultHost: string;
  /** Build the GET + create plan for one resource against `base`. */
  plan(resource: GcpResource, ctx: { base: string; project: string }): ApplyPlan;
}

/**
 * Map a CNRM StorageBucket to a GCS Buckets:insert body. Pure. CNRM mirrors the
 * Terraform google provider which mirrors the GCS API, so most fields are
 * field-for-field; the renames are `uniformBucketLevelAccess` →
 * `iamConfiguration.uniformBucketLevelAccess.enabled` and `lifecycleRule` →
 * `lifecycle.rule`.
 */
export function bucketInsertBody(cnrm: CnrmStorageBucket): BucketInsertBody {
  const name = cnrm.metadata?.name;
  if (!name) throw new Error("StorageBucket has no metadata.name");
  const spec = cnrm.spec ?? {};
  const body: BucketInsertBody = { name };
  if (spec.location) body.location = spec.location;
  if (spec.storageClass) body.storageClass = spec.storageClass;
  if (spec.uniformBucketLevelAccess !== undefined) {
    body.iamConfiguration = { uniformBucketLevelAccess: { enabled: spec.uniformBucketLevelAccess } };
  }
  if (spec.versioning?.enabled !== undefined) {
    body.versioning = { enabled: spec.versioning.enabled };
  }
  if (spec.lifecycleRule?.length) {
    body.lifecycle = {
      rule: spec.lifecycleRule.map((r) => ({
        action: r.action ?? {},
        ...(r.condition ? { condition: r.condition } : {}),
      })),
    };
  }
  return body;
}

/** Map a CNRM PubSubTopic to a Pub/Sub Topic body. Pure. Name travels in the URL. */
export function pubSubTopicBody(resource: GcpResource): PubSubTopicBody {
  const spec = (resource.spec ?? {}) as { messageRetentionDuration?: string };
  const body: PubSubTopicBody = {};
  const labels = resource.metadata?.labels;
  if (labels && Object.keys(labels).length) body.labels = labels;
  if (spec.messageRetentionDuration) body.messageRetentionDuration = spec.messageRetentionDuration;
  return body;
}

export const storageBucketMapper: ResourceMapper = {
  kind: "StorageBucket",
  defaultHost: "https://storage.googleapis.com",
  plan(resource, { base, project }) {
    const body = bucketInsertBody(resource as CnrmStorageBucket);
    return {
      getUrl: `${base}/storage/v1/b/${encodeURIComponent(body.name)}`,
      create: { method: "POST", url: `${base}/storage/v1/b?project=${encodeURIComponent(project)}`, body },
    };
  },
};

export const pubSubTopicMapper: ResourceMapper = {
  kind: "PubSubTopic",
  defaultHost: "https://pubsub.googleapis.com",
  plan(resource, { base, project }) {
    const topic = resource.metadata?.name;
    if (!topic) throw new Error("PubSubTopic has no metadata.name");
    // Pub/Sub creates a topic with an idempotent PUT to its resource URL; GET the
    // same URL for the existence check.
    const url = `${base}/v1/projects/${encodeURIComponent(project)}/topics/${encodeURIComponent(topic)}`;
    return { getUrl: url, create: { method: "PUT", url, body: pubSubTopicBody(resource) } };
  },
};

/** The kind → mapper dispatch table. Adding a resource type is a new entry here. */
export const MAPPERS: Record<string, ResourceMapper> = {
  StorageBucket: storageBucketMapper,
  PubSubTopic: pubSubTopicMapper,
};

// ── Resolution + HTTP ─────────────────────────────────────────────────────────

/** Resolve the project: `GOOGLE_CLOUD_PROJECT` env, else the CNRM project-id annotation. Pure. */
export function resolveGcpProject(resource: GcpResource, env: NodeJS.ProcessEnv = process.env): string {
  const project = env.GOOGLE_CLOUD_PROJECT || resource.metadata?.annotations?.[PROJECT_ID_ANNOTATION];
  if (!project) {
    throw new Error(
      `no GCP project — set GOOGLE_CLOUD_PROJECT or the ${PROJECT_ID_ANNOTATION} annotation`,
    );
  }
  return project;
}

/** Injectable HTTP client — mirrors argo's injectable fetcher so tests avoid the network. */
export type GcpHttp = (
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

const defaultHttp: GcpHttp = async (method, url, body, signal) => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return { status: res.status, text: await res.text() };
};

/**
 * Idempotently apply one resource via its mapper: `GET` it, skip on 200, else
 * issue the mapper's create request. `http` is injectable for tests.
 */
export async function applyResource(
  mapper: ResourceMapper,
  resource: GcpResource,
  ctx: { base: string; project: string },
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{ kind: string; name: string; created: boolean }> {
  const plan = mapper.plan(resource, ctx);
  const name = resource.metadata?.name ?? "?";
  const get = await http("GET", plan.getUrl, undefined, signal);
  if (get.status === 200) {
    return { kind: mapper.kind, name, created: false };
  }
  const res = await http(plan.create.method, plan.create.url, plan.create.body, signal);
  if (res.status >= 300) {
    throw new Error(`${mapper.kind} ${name} create failed (${res.status}): ${res.text}`);
  }
  return { kind: mapper.kind, name, created: true };
}

/** Parse a built manifest into CNRM resource objects — YAML (multi-doc) or JSON. Pure. */
export function parseManifest(content: string, path: string): GcpResource[] {
  if (/\.json$/i.test(path)) {
    const parsed = JSON.parse(content) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]) as GcpResource[];
  }
  return content
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter(Boolean)
    .map((doc) => parseYAML(doc) as GcpResource);
}

export interface GcpApplyArgs {
  /** Path to a built CNRM manifest (YAML multi-doc or JSON). */
  manifestPath: string;
  /** GCS/GCP endpoint override for all kinds (e.g. floci-gcp `:4588`). Default: each kind's real-GCP host. */
  endpoint?: string;
  /** Project override. Default: `GOOGLE_CLOUD_PROJECT` env / CNRM annotation. */
  project?: string;
}

/**
 * The native GCP applier (#706) — read a built CNRM manifest and apply each
 * resource directly to its GCP REST API, targeting a local floci-gcp emulator or
 * real GCP by endpoint override. Unlike AWS/Azure/k8s, GCP has no native deploy
 * service to shell out to, so chant maps each `kind` to a REST call itself (the
 * `MAPPERS` dispatch table). Unknown kinds are skipped. Uses longInfra profile.
 * `http` is injectable for tests.
 */
export async function gcpApply(
  args: GcpApplyArgs,
  signal?: AbortSignal,
  http: GcpHttp = defaultHttp,
): Promise<{ applied: Array<{ kind: string; name: string; created: boolean }> }> {
  const resources = parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath);
  const applied: Array<{ kind: string; name: string; created: boolean }> = [];
  for (const r of resources) {
    const mapper = r.kind ? MAPPERS[r.kind] : undefined;
    if (!mapper) {
      if (r.kind) console.log(`skip: no mapper for kind ${r.kind}`);
      continue;
    }
    const base = (args.endpoint ?? mapper.defaultHost).replace(/\/$/, "");
    const project = args.project ?? resolveGcpProject(r);
    safeHeartbeat({ step: "gcpApply", kind: mapper.kind, name: r.metadata?.name });
    const result = await applyResource(mapper, r, { base, project }, http, signal);
    console.log(`${result.created ? "created" : "exists"}: ${result.kind}/${result.name} (${base})`);
    applied.push(result);
  }
  return { applied };
}
