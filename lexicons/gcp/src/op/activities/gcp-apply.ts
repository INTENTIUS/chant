import { readFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";
import { safeHeartbeat, sleep } from "@intentius/chant/op";
import { hasOwnershipMarker, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import { GCP_RESOURCE_OWNERSHIP_KEYS } from "../../ownership";
import {
  applyResult,
  type ApplyResult,
  type AppliedResource,
  type NotAttemptedResource,
} from "@intentius/chant/apply";

const PROJECT_ID_ANNOTATION = "cnrm.cloud.google.com/project-id";

/**
 * The GCP labels chant stamps on resources it creates.
 *
 * Only the managed-by marker, not stack/env: this applier has no ownership
 * marker to hand — the serializer stamps those from project config onto the
 * Config Connector object. Same shape the fly serializer uses when no ownership
 * context is set.
 */
export function chantOwnershipLabels(): Record<string, string> {
  return { [GCP_RESOURCE_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE };
}

/**
 * True when a live resource's labels carry chant's ownership marker.
 *
 * Resolves through core's `hasOwnershipMarker` against the lexicon's declared
 * GCP-resource channel (#1446) rather than comparing a string literal inline,
 * so the stamp and the prune filter cannot drift. The key itself is unchanged
 * and deliberately GCP-valid — see `../../ownership.ts` for why this surface
 * cannot use core's `LABEL_OWNERSHIP_KEYS`.
 */
export function isChantOwned(labels: Record<string, string> | null | undefined): boolean {
  return hasOwnershipMarker(labels ?? undefined, GCP_RESOURCE_OWNERSHIP_KEYS);
}

/** Merge the ownership marker into a create/update body's `labels`. */
function stampOwnership<T extends object>(body: T): T & { labels: Record<string, string> } {
  const existing = (body as { labels?: Record<string, string> }).labels ?? {};
  return { ...body, labels: { ...existing, ...chantOwnershipLabels() } };
}

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

/** How to list live resources of a kind, so `prune` can find chant-owned orphans. */
export interface ListSpec {
  /** LIST endpoint for the kind. */
  url(ctx: { base: string; project: string }): string;
  /** Extract `{ name, labels }` for each item from the LIST response body. */
  items(responseBody: unknown): Array<{ name: string; labels?: Record<string, string> | null }>;
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
  /** Present when the kind can be pruned (list live → delete chant-owned orphans). */
  list?: ListSpec;
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
    const body = stampOwnership(bucketInsertBody(resource as CnrmStorageBucket));
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
  list: {
    url: ({ base, project }) => `${base}/storage/v1/b?project=${encodeURIComponent(project)}`,
    items: (body) => ((body as { items?: Array<{ name: string; labels?: Record<string, string> | null }> })?.items ?? []),
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
    const body = stampOwnership(pubSubTopicBody(resource));
    // UpdateTopic uses the {topic, updateMask} envelope — the mask lists the
    // fields being set (labels, messageRetentionDuration).
    const update = {
      method: "PATCH" as const,
      url,
      body: { topic: { name: `projects/${project}/topics/${topic}`, ...body }, updateMask: Object.keys(body).join(",") },
    };
    return { getUrl: url, create: { method: "PUT", url, body }, update };
  },
  list: {
    url: ({ base, project }) => `${base}/v1/projects/${encodeURIComponent(project)}/topics`,
    items: (body) =>
      ((body as { topics?: Array<{ name: string; labels?: Record<string, string> | null }> })?.topics ?? []).map(
        (t) => ({ name: t.name.split("/").pop() ?? t.name, labels: t.labels }),
      ),
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

/** Map a CNRM SecretManagerSecret to a Secret Manager create body. Pure. */
export function secretBody(resource: GcpResource): Record<string, unknown> {
  const spec = (resource.spec ?? {}) as { replication?: unknown };
  return { replication: spec.replication ?? { automatic: {} } };
}

export const secretManagerSecretMapper: ResourceMapper = {
  kind: "SecretManagerSecret",
  defaultHost: "https://secretmanager.googleapis.com",
  plan(resource, { base, project }) {
    const name = resource.metadata?.name;
    if (!name) throw new Error("SecretManagerSecret has no metadata.name");
    const secrets = `${base}/v1/projects/${encodeURIComponent(project)}/secrets`;
    const url = `${secrets}/${encodeURIComponent(name)}`;
    const body = stampOwnership(secretBody(resource));
    return {
      getUrl: url,
      create: { method: "POST", url: `${secrets}?secretId=${encodeURIComponent(name)}`, body },
      // UpdateSecret carries the updateMask in the query; only labels are mutable here.
      update: { method: "PATCH", url: `${url}?updateMask=labels`, body: { labels: body.labels } },
    };
  },
  list: {
    url: ({ base, project }) => `${base}/v1/projects/${encodeURIComponent(project)}/secrets`,
    items: (body) =>
      ((body as { secrets?: Array<{ name: string; labels?: Record<string, string> | null }> })?.secrets ?? []).map(
        (s) => ({ name: s.name.split("/").pop() ?? s.name, labels: s.labels }),
      ),
  },
};

/** Map a CNRM IAMServiceAccount to a service-account create body. Pure. */
export function serviceAccountBody(resource: GcpResource, accountId: string): Record<string, unknown> {
  const spec = (resource.spec ?? {}) as { displayName?: string };
  return { accountId, serviceAccount: spec.displayName ? { displayName: spec.displayName } : {} };
}

export const gcpServiceAccountMapper: ResourceMapper = {
  kind: "IAMServiceAccount",
  defaultHost: "https://iam.googleapis.com",
  plan(resource, { base, project }) {
    const accountId = resource.metadata?.name;
    if (!accountId) throw new Error("IAMServiceAccount has no metadata.name");
    // The GCP identity is the derived email; IAM service accounts carry no labels,
    // so there is no ownership stamping / prune for this kind.
    const email = `${accountId}@${project}.iam.gserviceaccount.com`;
    const accounts = `${base}/v1/projects/${encodeURIComponent(project)}/serviceAccounts`;
    return {
      getUrl: `${accounts}/${email}`,
      create: { method: "POST", url: accounts, body: serviceAccountBody(resource, accountId) },
    };
  },
};

/** The kind → mapper dispatch table. Adding a resource type is a new entry here. */
export const MAPPERS: Record<string, ResourceMapper> = {
  StorageBucket: storageBucketMapper,
  PubSubTopic: pubSubTopicMapper,
  PubSubSubscription: pubSubSubscriptionMapper,
  SecretManagerSecret: secretManagerSecretMapper,
  IAMServiceAccount: gcpServiceAccountMapper,
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

/**
 * Resolve the endpoint override (#1449): an explicit `endpoint` arg wins, then
 * the `GCP_ENDPOINT_URL` env — the same variable the read path honours
 * (`describe-resources`, floci-gcp), so an apply lands wherever `--live` is
 * already looking. `undefined` means no override: each kind falls back to its
 * real-GCP host. The same rule the aws applier applies to `AWS_ENDPOINT_URL`
 * (#1694) and the fly applier to `FLY_FLAPS_BASE_URL`. Pure.
 */
export function resolveGcpEndpoint(
  args: { endpoint?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return args.endpoint || env.GCP_ENDPOINT_URL || undefined;
}

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

/**
 * A manifest entry with no `kind` is malformed, not unsupported (#1447).
 *
 * The old guard skipped it in silence, which put a hand-written or truncated
 * manifest in the same bucket as a kind chant simply has no mapper for. One is
 * a bug in the input and the other is a known gap in coverage; only the second
 * belongs in `notAttempted`. Throws so the first surfaces.
 */
function requireKind(resource: GcpResource, manifestPath: string): boolean {
  if (!resource.kind) {
    const name = resource.metadata?.name;
    throw new Error(
      `${manifestPath}: manifest entry has no "kind"${name ? ` (metadata.name: ${name})` : ""} — ` +
        `a CNRM resource must declare one. This is a malformed manifest, not an unsupported kind.`,
    );
  }
  return true;
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
  /** GCS/GCP endpoint override for all kinds (e.g. floci-gcp `:4588`).
   * Default: `GCP_ENDPOINT_URL` env, else each kind's real-GCP host. */
  endpoint?: string;
  /** Project override. Default: `GOOGLE_CLOUD_PROJECT` env / CNRM annotation. */
  project?: string;
  /**
   * Delete chant-owned resources of a manifested kind that are no longer in the
   * manifest (owned-only prune). Destructive — off by default. Only kinds with a
   * `list` mapper are pruned; foreign (non-chant) resources are never touched.
   */
  prune?: boolean;
}

/**
 * Normalize a gcp apply/delete result into core's apply envelope (#1446).
 *
 * The lexicon keeps its own richer shape — `created`/`updated` per resource,
 * the CNRM `kind` — and this projects it onto the shared tri-state so a caller
 * can read any applier's result the same way. Core's contract is the interface;
 * it is not a replacement for what this applier knows.
 */
export function toApplyResult(result: {
  applied?: Array<{ kind: string; name: string; created: boolean; updated: boolean }>;
  deleted?: Array<{ kind: string; name: string; deleted: boolean }>;
  pruned?: Array<{ kind: string; name: string; deleted: boolean }>;
  notAttempted?: GcpNotAttempted[];
  notPrunable?: GcpNotPrunable[];
}): ApplyResult {
  const applied: AppliedResource[] = (result.applied ?? []).map((a) => ({
    kind: a.kind,
    name: a.name,
    action: a.created ? "created" : a.updated ? "updated" : "unchanged",
  }));
  const notAttempted: NotAttemptedResource[] = [
    ...(result.notAttempted ?? []).map((n) => ({ kind: n.kind, name: n.name, reason: n.reason })),
    // A kind the prune could not consider has no single resource name — the
    // whole kind went unexamined, which `not-prunable` is the reason for.
    ...(result.notPrunable ?? []).map((n) => ({
      kind: n.kind,
      name: "*",
      reason: "not-prunable" as const,
      ...(n.detail ? { detail: n.detail } : {}),
    })),
  ];
  // `gcpDelete` reports deletions as `deleted`; they are prunes in the shared
  // vocabulary — the applier removed something the plan no longer wants.
  return applyResult(applied, result.pruned ?? result.deleted ?? [], notAttempted);
}

/**
 * A resource this run did not attempt, and why (#1447).
 *
 * The read path learned this in #1089/#1201: a read that never happened is not
 * the same fact as a resource that is not there, and collapsing the two made
 * "absent" mean both. `observation.ts` puts it as "a warn on stderr is not a
 * signal in a change set" — and a `console.log` on stdout is not a signal in an
 * apply result, for the same reason. So the skips ride the return value.
 */
export interface GcpNotAttempted {
  kind: string;
  name: string;
  /** `MAPPERS` has no entry for this kind, so no REST call exists to make. */
  reason: "unsupported-kind";
}

/** A kind an owned-only prune could not consider, and why (#1447). */
export interface GcpNotPrunable {
  kind: string;
  /**
   * - `no-list-capability` — the mapper cannot enumerate live resources of this
   *   kind, so an owned orphan of it is never even a delete candidate.
   * - `list-failed` — the list call itself failed. Transient or not, it means
   *   this kind was not considered, which `pruned: []` alone would report as
   *   "nothing to prune".
   */
  reason: "no-list-capability" | "list-failed";
  /** Status and body for `list-failed`, so the caller can tell apart a 403 from a 500. */
  detail?: string;
}

/**
 * Owned-only prune: for each manifested kind with `list` support, delete the
 * chant-owned live resources whose name is not in `desiredByKind`. Foreign
 * resources (no ownership label) are left alone.
 *
 * Returns what it could not consider alongside what it deleted — a kind with no
 * `list`, or whose list call failed, is reported rather than dropped (#1447).
 */
export async function pruneOrphans(
  desired: GcpResource[],
  resolve: (mapper: ResourceMapper, resource?: GcpResource) => { base: string; project: string },
  http: GcpHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{
  pruned: Array<{ kind: string; name: string; deleted: boolean }>;
  notPrunable: GcpNotPrunable[];
}> {
  const desiredByKind = new Map<string, Set<string>>();
  for (const r of desired) {
    if (!r.kind) continue;
    const names = desiredByKind.get(r.kind) ?? new Set<string>();
    if (r.metadata?.name) names.add(r.metadata.name);
    desiredByKind.set(r.kind, names);
  }

  const pruned: Array<{ kind: string; name: string; deleted: boolean }> = [];
  const notPrunable: GcpNotPrunable[] = [];
  for (const [kind, keep] of desiredByKind) {
    const mapper = MAPPERS[kind];
    if (!mapper?.list) {
      console.log(`prune: cannot list kind ${kind} — owned orphans of it are not considered`);
      notPrunable.push({ kind, reason: "no-list-capability" });
      continue;
    }
    const ctx = resolve(mapper, desired.find((r) => r.kind === kind));
    const res = await http("GET", mapper.list.url(ctx), undefined, signal);
    if (res.status >= 300) {
      console.log(`prune: listing kind ${kind} failed (${res.status}) — not considered`);
      notPrunable.push({ kind, reason: "list-failed", detail: `${res.status}: ${res.text}` });
      continue;
    }
    for (const item of mapper.list.items(parseJson(res.text))) {
      if (!isChantOwned(item.labels) || keep.has(item.name)) continue;
      safeHeartbeat({ step: "prune", kind, name: item.name });
      const result = await deleteResource(mapper, { kind, metadata: { name: item.name } }, ctx, http, signal);
      console.log(`pruned: ${kind}/${item.name} (${ctx.base})`);
      pruned.push(result);
    }
  }
  return { pruned, notPrunable };
}

/**
 * The native GCP applier (#706) — read a built CNRM manifest and apply each
 * resource directly to its GCP REST API, targeting a local floci-gcp emulator or
 * real GCP by endpoint override. Unlike AWS/Azure/k8s, GCP has no native deploy
 * service to shell out to, so chant maps each `kind` to a REST call itself (the
 * `MAPPERS` dispatch table). Uses longInfra profile. `http` is injectable for
 * tests.
 *
 * A kind `MAPPERS` does not cover is **reported, not dropped** — it comes back
 * in `notAttempted` (#1447). Before that, it was a `console.log` and a
 * populated `applied` array, so a caller could not tell a partial apply from a
 * complete one and `ApplyOp` reported success either way.
 */
export async function gcpApply(
  args: GcpApplyArgs,
  signal?: AbortSignal,
  http: GcpHttp = defaultHttp,
): Promise<{
  applied: Array<{ kind: string; name: string; created: boolean; updated: boolean }>;
  pruned: Array<{ kind: string; name: string; deleted: boolean }>;
  /** Declared resources no REST call was made for. Empty on a complete apply. */
  notAttempted: GcpNotAttempted[];
  /** Kinds the prune could not consider. Empty when `prune` is off. */
  notPrunable: GcpNotPrunable[];
}> {
  const resources = orderByReferences(parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath));
  const endpoint = resolveGcpEndpoint(args);
  const resolve = (mapper: ResourceMapper, resource?: GcpResource) => ({
    base: (endpoint ?? mapper.defaultHost).replace(/\/$/, ""),
    project: args.project ?? (resource ? resolveGcpProject(resource) : ""),
  });

  const applied: Array<{ kind: string; name: string; created: boolean; updated: boolean }> = [];
  const notAttempted: GcpNotAttempted[] = [];
  for (const r of resources) {
    const mapper = requireKind(r, args.manifestPath) ? MAPPERS[r.kind as string] : undefined;
    if (!mapper) {
      const kind = r.kind as string;
      console.log(`skip: no mapper for kind ${kind}`);
      notAttempted.push({ kind, name: r.metadata?.name ?? "?", reason: "unsupported-kind" });
      continue;
    }
    const ctx = resolve(mapper, r);
    safeHeartbeat({ step: "gcpApply", kind: mapper.kind, name: r.metadata?.name });
    const result = await applyResource(mapper, r, ctx, http, signal);
    const verb = result.created ? "created" : result.updated ? "updated" : "unchanged";
    console.log(`${verb}: ${result.kind}/${result.name} (${ctx.base})`);
    applied.push(result);
  }

  const prune = args.prune
    ? await pruneOrphans(resources, resolve, http, signal)
    : { pruned: [], notPrunable: [] };
  return { applied, pruned: prune.pruned, notAttempted, notPrunable: prune.notPrunable };
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
): Promise<{
  deleted: Array<{ kind: string; name: string; deleted: boolean }>;
  /** Declared resources no delete was attempted for — the delete-side twin of
   * `gcpApply`'s field, and the more consequential one: a caller reading only
   * `deleted` would believe the manifest was fully torn down (#1447). */
  notAttempted: GcpNotAttempted[];
}> {
  // Delete in reverse dependency order: a referrer goes before the resource it
  // references.
  const resources = orderByReferences(parseManifest(readFileSync(args.manifestPath, "utf8"), args.manifestPath)).reverse();
  const deleted: Array<{ kind: string; name: string; deleted: boolean }> = [];
  const notAttempted: GcpNotAttempted[] = [];
  for (const r of resources) {
    const mapper = requireKind(r, args.manifestPath) ? MAPPERS[r.kind as string] : undefined;
    if (!mapper) {
      const kind = r.kind as string;
      console.log(`skip: no mapper for kind ${kind}`);
      notAttempted.push({ kind, name: r.metadata?.name ?? "?", reason: "unsupported-kind" });
      continue;
    }
    const base = (resolveGcpEndpoint(args) ?? mapper.defaultHost).replace(/\/$/, "");
    const project = args.project ?? resolveGcpProject(r);
    safeHeartbeat({ step: "gcpDelete", kind: mapper.kind, name: r.metadata?.name });
    const result = await deleteResource(mapper, r, { base, project }, http, signal);
    console.log(`${result.deleted ? "deleted" : "absent"}: ${result.kind}/${result.name} (${base})`);
    deleted.push(result);
  }
  return { deleted, notAttempted };
}
