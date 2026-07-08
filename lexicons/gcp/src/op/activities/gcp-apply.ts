import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

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

/**
 * One HTTP plan: an idempotency `GET` (200 = exists), the create request, and —
 * when the resource supports in-place reconcile — the update request. A mapper
 * that omits `update` leaves an existing resource untouched (skip-if-exists).
 */
export interface ApplyPlan {
  getUrl: string;
  create: { method: "POST" | "PUT"; url: string; body: unknown };
  update?: { method: "PATCH" | "PUT"; url: string; body: unknown };
}

/**
 * Handles an async create whose response is a long-running operation. Present
 * only on mappers for resources that provision asynchronously (Cloud Run, GKE,
 * Cloud SQL, …); synchronous resources (buckets, topics) omit it.
 */
export interface OperationSpec {
  /**
   * URL to poll from the create response, or `undefined` when the create
   * completed synchronously (returned the resource, not an operation).
   */
  pollUrl(createResponseBody: unknown, ctx: { base: string; project: string }): string | undefined;
  /** True once the polled operation body reports completion. */
  isDone(operationBody: unknown): boolean;
  /** An error message from a completed-with-error operation, else undefined. */
  error(operationBody: unknown): string | undefined;
}

/** Maps one CNRM kind to its GCP REST operations. The unit of the dispatch table. */
export interface ResourceMapper {
  /** CNRM kind this handles. */
  kind: string;
  /** Real-GCP API host, used when no `endpoint` override is given. */
  defaultHost: string;
  /** Build the GET + create plan for one resource against `base`. */
  plan(resource: GcpResource, ctx: { base: string; project: string }): ApplyPlan;
  /** Present for async resources whose create returns a long-running operation. */
  operation?: OperationSpec;
}

/**
 * A standard `google.longrunning` operation spec: the create response carries an
 * operation `name` (`projects/…/operations/…`), polled at `{base}/{version}/{name}`
 * until `done: true`. Reused by every service that follows the pattern.
 */
export function longRunningOperation(version: string): OperationSpec {
  return {
    pollUrl(createResponseBody, { base }) {
      const opName = (createResponseBody as { name?: string })?.name;
      if (!opName || !opName.includes("/operations/")) return undefined;
      return `${base}/${version}/${opName}`;
    },
    isDone(operationBody) {
      return (operationBody as { done?: boolean })?.done === true;
    },
    error(operationBody) {
      return (operationBody as { error?: { message?: string } })?.error?.message;
    },
  };
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
    const url = `${base}/storage/v1/b/${encodeURIComponent(body.name)}`;
    // Reconcile in place with a PATCH of the desired mutable fields (the name is
    // immutable and travels in the URL).
    const { name: _name, ...patch } = body;
    return {
      getUrl: url,
      create: { method: "POST", url: `${base}/storage/v1/b?project=${encodeURIComponent(project)}`, body },
      update: { method: "PATCH", url, body: patch },
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

/** Map a CNRM RunService to a Cloud Run v2 Service body. Pure. */
export function cloudRunServiceBody(resource: GcpResource): { template?: unknown } {
  const spec = (resource.spec ?? {}) as { template?: unknown };
  const body: { template?: unknown } = {};
  if (spec.template) body.template = spec.template;
  return body;
}

export const cloudRunServiceMapper: ResourceMapper = {
  kind: "RunService",
  defaultHost: "https://run.googleapis.com",
  // Cloud Run create is asynchronous — it returns a google.longrunning operation.
  operation: longRunningOperation("v2"),
  plan(resource, { base, project }) {
    const name = resource.metadata?.name;
    if (!name) throw new Error("RunService has no metadata.name");
    const location = ((resource.spec ?? {}) as { location?: string }).location ?? "us-central1";
    const services = `${base}/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/services`;
    const url = `${services}/${encodeURIComponent(name)}`;
    return {
      getUrl: url,
      create: {
        method: "POST",
        url: `${services}?serviceId=${encodeURIComponent(name)}`,
        body: cloudRunServiceBody(resource),
      },
      // Cloud Run reconciles with a PATCH of the service; like create it returns
      // a long-running operation, polled via the mapper's `operation`.
      update: { method: "PATCH", url, body: cloudRunServiceBody(resource) },
    };
  },
};

/**
 * Map a CNRM PubSubSubscription to a Pub/Sub Subscription body, resolving the
 * `topicRef` to a full topic path. Pure.
 */
export function pubSubSubscriptionBody(resource: GcpResource, project: string): Record<string, unknown> {
  const spec = (resource.spec ?? {}) as {
    topicRef?: { name?: string; external?: string };
    ackDeadlineSeconds?: number;
  };
  const ref = spec.topicRef;
  const topic = ref?.external ?? (ref?.name ? `projects/${project}/topics/${ref.name}` : undefined);
  if (!topic) throw new Error("PubSubSubscription has no spec.topicRef.name");
  const body: Record<string, unknown> = { topic };
  if (spec.ackDeadlineSeconds !== undefined) body.ackDeadlineSeconds = spec.ackDeadlineSeconds;
  return body;
}

export const pubSubSubscriptionMapper: ResourceMapper = {
  kind: "PubSubSubscription",
  defaultHost: "https://pubsub.googleapis.com",
  plan(resource, { base, project }) {
    const sub = resource.metadata?.name;
    if (!sub) throw new Error("PubSubSubscription has no metadata.name");
    const url = `${base}/v1/projects/${encodeURIComponent(project)}/subscriptions/${encodeURIComponent(sub)}`;
    return { getUrl: url, create: { method: "PUT", url, body: pubSubSubscriptionBody(resource, project) } };
  },
};

/** The kind → mapper dispatch table. Adding a resource type is a new entry here. */
export const MAPPERS: Record<string, ResourceMapper> = {
  StorageBucket: storageBucketMapper,
  PubSubTopic: pubSubTopicMapper,
  PubSubSubscription: pubSubSubscriptionMapper,
  RunService: cloudRunServiceMapper,
};

/**
 * Collect the local resource names this resource references via CNRM `*Ref`
 * fields (`topicRef: { name }`, `subnetworkRefs: [{ name }]`, …). `external`
 * refs point outside the manifest and are ignored for ordering. Pure.
 */
export function referencedNames(resource: GcpResource): string[] {
  const names: string[] = [];
  const visit = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key);
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (key && /Refs?$/.test(key) && typeof obj.name === "string") {
        names.push(obj.name);
      }
      for (const [k, val] of Object.entries(obj)) visit(val, k);
    }
  };
  visit(resource.spec);
  return [...new Set(names)];
}

/**
 * Topologically order resources so a referenced resource comes before the
 * resource that references it (apply order; reverse for delete). Refs to names
 * not in the manifest are left to exist already. Throws on a reference cycle.
 * Pure — a DFS post-order.
 */
export function orderByReferences(resources: GcpResource[]): GcpResource[] {
  const byName = new Map<string, GcpResource>();
  for (const r of resources) {
    const n = r.metadata?.name;
    if (n) byName.set(n, r);
  }
  const ordered: GcpResource[] = [];
  const done = new Set<GcpResource>();
  const active = new Set<GcpResource>();
  const visit = (r: GcpResource): void => {
    if (done.has(r)) return;
    if (active.has(r)) throw new Error(`reference cycle involving ${r.metadata?.name ?? "?"}`);
    active.add(r);
    for (const ref of referencedNames(r)) {
      const dep = byName.get(ref);
      if (dep && dep !== r) visit(dep);
    }
    active.delete(r);
    done.add(r);
    ordered.push(r);
  };
  for (const r of resources) visit(r);
  return ordered;
}

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
 * Reconcile one resource via its mapper: `GET` it; if present, PATCH it to the
 * desired state (when the mapper supports `update`, else leave it); if absent,
 * create it. Async create/update return an operation that is polled to
 * completion. `http` is injectable for tests.
 */
export async function applyResource(
  mapper: ResourceMapper,
  resource: GcpResource,
  ctx: { base: string; project: string },
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{ kind: string; name: string; created: boolean; updated: boolean }> {
  const plan = mapper.plan(resource, ctx);
  const name = resource.metadata?.name ?? "?";
  const get = await http("GET", plan.getUrl, undefined, signal);

  if (get.status === 200) {
    // Exists. Reconcile to desired if the mapper supports it; otherwise leave it.
    if (!plan.update) {
      return { kind: mapper.kind, name, created: false, updated: false };
    }
    const res = await http(plan.update.method, plan.update.url, plan.update.body, signal);
    if (res.status >= 300) {
      throw new Error(`${mapper.kind} ${name} update failed (${res.status}): ${res.text}`);
    }
    await pollIfAsync(mapper, res.text, ctx, http, signal);
    return { kind: mapper.kind, name, created: false, updated: true };
  }

  const res = await http(plan.create.method, plan.create.url, plan.create.body, signal);
  if (res.status >= 300) {
    throw new Error(`${mapper.kind} ${name} create failed (${res.status}): ${res.text}`);
  }
  await pollIfAsync(mapper, res.text, ctx, http, signal);
  return { kind: mapper.kind, name, created: true, updated: false };
}

/**
 * When a mapper is async, extract the long-running operation from a create/update
 * response and poll it to completion so the step never reports success early.
 */
async function pollIfAsync(
  mapper: ResourceMapper,
  responseText: string,
  ctx: { base: string; project: string },
  http: GcpHttp,
  signal?: AbortSignal,
): Promise<void> {
  if (!mapper.operation) return;
  const pollUrl = mapper.operation.pollUrl(parseJson(responseText), ctx);
  if (pollUrl) {
    await waitForOperation(mapper.operation, pollUrl, http, signal);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Poll a long-running operation until it reports done (or errors / times out).
 * `http` and the interval are injectable so tests drive it without real waits.
 */
export async function waitForOperation(
  op: OperationSpec,
  pollUrl: string,
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const interval = opts?.intervalMs ?? 2_000;
  const deadline = Date.now() + (opts?.timeoutMs ?? 300_000);
  let attempt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("waitForOperation aborted");
    attempt++;
    safeHeartbeat({ step: "waitForOperation", attempt });
    const res = await http("GET", pollUrl, undefined, signal);
    const body = res.status < 300 ? parseJson(res.text) : undefined;
    if (body) {
      const err = op.error(body);
      if (err) throw new Error(`operation failed: ${err}`);
      if (op.isDone(body)) return;
    }
    await sleep(interval, signal);
  }
  throw new Error(`operation did not complete within timeout: ${pollUrl}`);
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
): Promise<{ applied: Array<{ kind: string; name: string; created: boolean; updated: boolean }> }> {
  const resources = orderByReferences(parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath));
  const applied: Array<{ kind: string; name: string; created: boolean; updated: boolean }> = [];
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
    const verb = result.created ? "created" : result.updated ? "updated" : "unchanged";
    console.log(`${verb}: ${result.kind}/${result.name} (${base})`);
    applied.push(result);
  }
  return { applied };
}

/**
 * Idempotently delete one resource: `DELETE` its resource URL. A 404 means it is
 * already gone. For async resources, `DELETE` returns a long-running operation
 * that is polled to completion. `http` is injectable for tests.
 */
export async function deleteResource(
  mapper: ResourceMapper,
  resource: GcpResource,
  ctx: { base: string; project: string },
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{ kind: string; name: string; deleted: boolean }> {
  const plan = mapper.plan(resource, ctx);
  const name = resource.metadata?.name ?? "?";
  const res = await http("DELETE", plan.getUrl, undefined, signal);
  if (res.status === 404) {
    return { kind: mapper.kind, name, deleted: false };
  }
  if (res.status >= 300) {
    throw new Error(`${mapper.kind} ${name} delete failed (${res.status}): ${res.text}`);
  }
  if (mapper.operation) {
    const pollUrl = mapper.operation.pollUrl(parseJson(res.text), ctx);
    if (pollUrl) {
      await waitForOperation(mapper.operation, pollUrl, http, signal);
    }
  }
  return { kind: mapper.kind, name, deleted: true };
}

/**
 * The inverse of {@link gcpApply} — read a built CNRM manifest and delete the
 * resources it declares (in reverse order, so dependents go before their
 * dependencies). Idempotent: already-absent resources are a no-op. Uses
 * longInfra profile. `http` is injectable for tests.
 */
export async function gcpDelete(
  args: GcpApplyArgs,
  signal?: AbortSignal,
  http: GcpHttp = defaultHttp,
): Promise<{ deleted: Array<{ kind: string; name: string; deleted: boolean }> }> {
  // Delete in reverse dependency order: a referrer goes before the resource it
  // references.
  const resources = orderByReferences(parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath)).reverse();
  const deleted: Array<{ kind: string; name: string; deleted: boolean }> = [];
  for (const r of resources) {
    const mapper = r.kind ? MAPPERS[r.kind] : undefined;
    if (!mapper) {
      if (r.kind) console.log(`skip: no mapper for kind ${r.kind}`);
      continue;
    }
    const base = (args.endpoint ?? mapper.defaultHost).replace(/\/$/, "");
    const project = args.project ?? resolveGcpProject(r);
    safeHeartbeat({ step: "gcpDelete", kind: mapper.kind, name: r.metadata?.name });
    const result = await deleteResource(mapper, r, { base, project }, http, signal);
    console.log(`${result.deleted ? "deleted" : "absent"}: ${result.kind}/${result.name} (${base})`);
    deleted.push(result);
  }
  return { deleted };
}
