import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
import { safeHeartbeat } from "./heartbeat";

const DEFAULT_ENDPOINT = "https://storage.googleapis.com";
const PROJECT_ID_ANNOTATION = "cnrm.cloud.google.com/project-id";

/** Minimal shape of a serialized CNRM StorageBucket (`storage.cnrm.cloud.google.com`). */
export interface CnrmStorageBucket {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    location?: string;
    storageClass?: string;
    uniformBucketLevelAccess?: boolean;
    versioning?: { enabled?: boolean };
    lifecycleRule?: Array<{
      action?: Record<string, unknown>;
      condition?: Record<string, unknown>;
    }>;
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

/**
 * Map a CNRM StorageBucket to a GCS Buckets:insert body. Pure.
 *
 * The first entry in the GCP applier's kind→REST dispatch table (#711). CNRM
 * mirrors the Terraform google provider, which mirrors the GCS API, so the
 * mapping is largely field-for-field; the notable renames are
 * `uniformBucketLevelAccess` → `iamConfiguration.uniformBucketLevelAccess.enabled`
 * and `lifecycleRule` → `lifecycle.rule`.
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

/** Resolve the GCS API endpoint: `STORAGE_EMULATOR_HOST` (floci-gcp) else real GCS. Pure. */
export function resolveGcpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.STORAGE_EMULATOR_HOST || DEFAULT_ENDPOINT;
}

/** Resolve the project: `GOOGLE_CLOUD_PROJECT` env, else the CNRM project-id annotation. Pure. */
export function resolveGcpProject(cnrm: CnrmStorageBucket, env: NodeJS.ProcessEnv = process.env): string {
  const project = env.GOOGLE_CLOUD_PROJECT || cnrm.metadata?.annotations?.[PROJECT_ID_ANNOTATION];
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
 * Idempotently create one bucket: `GET` it, skip on 200, `POST` (create) on 404.
 * `http` is injectable for tests.
 */
export async function applyBucket(
  cnrm: CnrmStorageBucket,
  opts: { endpoint: string; project: string },
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{ bucket: string; created: boolean }> {
  const body = bucketInsertBody(cnrm);
  const base = opts.endpoint.replace(/\/$/, "");
  const get = await http("GET", `${base}/storage/v1/b/${encodeURIComponent(body.name)}`, undefined, signal);
  if (get.status === 200) {
    return { bucket: body.name, created: false };
  }
  const post = await http(
    "POST",
    `${base}/storage/v1/b?project=${encodeURIComponent(opts.project)}`,
    body,
    signal,
  );
  if (post.status >= 300) {
    throw new Error(`bucket create failed (${post.status}): ${post.text}`);
  }
  return { bucket: body.name, created: true };
}

/** Parse a built manifest into CNRM resource objects — YAML (multi-doc) or JSON. Pure. */
export function parseManifest(content: string, path: string): CnrmStorageBucket[] {
  if (/\.json$/i.test(path)) {
    const parsed = JSON.parse(content) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]) as CnrmStorageBucket[];
  }
  return content
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter(Boolean)
    .map((doc) => parseYAML(doc) as CnrmStorageBucket);
}

export interface GcpApplyArgs {
  /** Path to a built CNRM manifest (YAML multi-doc or JSON). */
  manifestPath: string;
  /** GCS endpoint override. Default: `STORAGE_EMULATOR_HOST` env, else real GCS. */
  endpoint?: string;
  /** Project override. Default: `GOOGLE_CLOUD_PROJECT` env / CNRM annotation. */
  project?: string;
}

/**
 * The native GCP applier (starter, #711) — read a built CNRM manifest and apply
 * the `StorageBucket` resources in it directly to the GCS REST API, targeting a
 * local floci-gcp emulator or real GCP by endpoint override. The first slice of
 * #706: a kind→mapper→REST dispatch that currently handles one kind. Uses
 * longInfra profile. `http` is injectable for tests.
 */
export async function gcpApply(
  args: GcpApplyArgs,
  signal?: AbortSignal,
  http: GcpHttp = defaultHttp,
): Promise<{ applied: string[] }> {
  const resources = parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath);
  const endpoint = args.endpoint ?? resolveGcpEndpoint();
  const applied: string[] = [];
  for (const r of resources) {
    if (r.kind !== "StorageBucket") continue; // dispatch table: one kind, for now
    safeHeartbeat({ step: "gcpApply", kind: r.kind, name: r.metadata?.name });
    const project = args.project ?? resolveGcpProject(r);
    const { bucket, created } = await applyBucket(r, { endpoint, project }, http, signal);
    console.log(`${created ? "created" : "exists"}: gs://${bucket} (${endpoint})`);
    applied.push(bucket);
  }
  return { applied };
}
