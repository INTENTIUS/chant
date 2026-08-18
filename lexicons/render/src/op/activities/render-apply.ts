/**
 * Render native applier.
 *
 * Peer of `flyApply`: a direct-REST applier that does its own diff, owned-only
 * prune, and mutation waiting. Render has no server-side declarative apply
 * (Blueprints are repo-driven, not API-driven), so this loop is hand-rolled —
 * find-by-name, then create or PATCH per resource, resolve cross-resource ids
 * as they become known, wait each service's deploy to `live`, and prune only
 * what chant owns.
 *
 * Input is the serializer's output: a JSON object keyed by entity name, each
 * value a single Render create request `{ kind, entityType, endpoint, method,
 * name, body, pathParams? }`. Bodies may carry three markers the applier
 * resolves at apply time:
 *   - `{ $ref: "<entity>" }`  → the live id of a declared entity (must apply first)
 *   - `{ $attr: { entity, attribute } }` → an attribute of a live entity
 *     (`id`, `dashboardUrl`, or a datastore's connection string, read from the
 *     `/connection-info` side endpoint)
 *   - `{ $owner: true }` → the workspace id, when neither the author nor
 *     `RENDER_OWNER_ID` named one; resolved once from `GET /owners`
 *
 * Identity. Render assigns opaque ids on create; the *name* is the reconcile
 * key. Services are unique-by-name per workspace (Render enforces it); for the
 * other kinds chant treats the name as unique within its scope (owner, or the
 * parent project/service) and takes the first exact match.
 *
 * Endpoint override via `RENDER_API_BASE_URL` (or an explicit `endpoint` arg)
 * so the same code points at api.render.com or a local stand-in; auth is a
 * bearer token from `RENDER_API_KEY` (or `token`).
 */

import { readFileSync } from "node:fs";
import { safeHeartbeat, sleep } from "@intentius/chant/op";
import { hasOwnershipMarker, readOwnership, type OwnershipMarker } from "@intentius/chant/ownership";
import {
  applyResult,
  type ApplyResult,
  type AppliedResource,
  type PrunedResource,
  type NotAttemptedResource,
} from "@intentius/chant/apply";
import { RENDER_ENV_OWNERSHIP_KEYS } from "../../ownership";
import {
  CATALOG,
  ENTITY_TYPES,
  ENTITY_TYPE_OF_SERVICE,
  catalogEntry,
  isServiceEntityType,
  type CatalogEntry,
} from "../../catalog";
import {
  isAttrMarker,
  isOwnerMarker,
  isRefMarker,
  type RenderPlan,
  type RenderRequest,
} from "../../serializer";

/** Default API host when neither an `endpoint` arg nor `RENDER_API_BASE_URL` is set. */
export const DEFAULT_RENDER_BASE_URL = "https://api.render.com/v1";

/** Render's list page cap. */
const PAGE_LIMIT = 100;

/** Deploy states that mean the deploy is finished. */
const DEPLOY_LIVE = new Set(["live"]);
const DEPLOY_FAILED = new Set(["build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"]);

// ── Pure helpers (unit-testable without http) ─────────────────────────────────

/**
 * Resolve the API base URL: an explicit `endpoint` arg wins, then
 * `RENDER_API_BASE_URL`, then api.render.com. Trailing slash stripped. Pure.
 */
export function resolveEndpoint(
  args: { endpoint?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = args.endpoint || env.RENDER_API_BASE_URL || DEFAULT_RENDER_BASE_URL;
  return base.replace(/\/$/, "");
}

/** Parse the serializer's JSON output into a plan. Pure. */
export function parsePlan(content: string): RenderPlan {
  return JSON.parse(content) as RenderPlan;
}

/** Collect the entity names a value references through `$ref`/`$attr` markers. Pure. */
export function collectDependencies(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (isRefMarker(value)) {
    acc.add(value.$ref);
    return acc;
  }
  if (isAttrMarker(value)) {
    acc.add(value.$attr.entity);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectDependencies(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectDependencies(v, acc);
  }
  return acc;
}

/**
 * Order the plan for apply: by catalog order (projects → environments →
 * datastores/env groups → services → disks/domains → webhooks), and within
 * that so every `$ref`/`$attr` target precedes its referrer. Throws on a cycle
 * or a dangling reference — both are authoring errors worth naming. Pure.
 */
export function orderPlan(plan: RenderPlan): Array<[string, RenderRequest]> {
  const entries = Object.entries(plan);
  const byName = new Map(entries);
  const deps = new Map<string, Set<string>>();
  for (const [name, req] of entries) {
    const d = collectDependencies({ body: req.body, pathParams: req.pathParams });
    for (const dep of d) {
      if (!byName.has(dep)) {
        throw new Error(`render plan entry "${name}" references "${dep}", which the plan does not declare`);
      }
    }
    d.delete(name);
    deps.set(name, d);
  }
  const rank = (name: string) => catalogEntry(byName.get(name)!.entityType).order;
  const sortedNames = entries.map(([n]) => n).sort((a, b) => rank(a) - rank(b));

  // Take the first ready entry in catalog order each time, so a resource is
  // only pulled ahead of its rank when something before it still waits on a
  // dependency (never behind a lower-ranked one that happens to be ready).
  const out: Array<[string, RenderRequest]> = [];
  const done = new Set<string>();
  const remaining = [...sortedNames];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((n) => [...deps.get(n)!].every((d) => done.has(d)));
    if (idx < 0) {
      throw new Error(`render plan has a reference cycle among: ${remaining.join(", ")}`);
    }
    const [n] = remaining.splice(idx, 1);
    out.push([n, byName.get(n)!]);
    done.add(n);
  }
  return out;
}

/** Structural equality over two values, key-order-insensitive. Pure. */
export function configEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * The PATCH body for a live resource: the declared values of the catalog's
 * patchable fields that differ from what is live. Only fields the author set
 * are compared — an omitted field is "leave as is", never "reset to default".
 * Returns `undefined` when nothing differs. Pure.
 */
export function diffForPatch(
  entry: CatalogEntry,
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const field of entry.patchFields) {
    if (!(field in desired) || desired[field] === undefined) continue;
    const want = desired[field];
    const have = live[field];
    if (want && typeof want === "object" && !Array.isArray(want) && have && typeof have === "object") {
      // Nested objects (serviceDetails, image): compare only the declared keys.
      const sub = subsetDiff(want as Record<string, unknown>, have as Record<string, unknown>);
      if (sub !== undefined) patch[field] = want;
    } else if (!configEqual(want, have)) {
      patch[field] = want;
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Recursive "declared keys differ" check; undefined when the declared subset matches. */
function subsetDiff(want: Record<string, unknown>, have: Record<string, unknown>): true | undefined {
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined) continue;
    const h = have[k];
    if (v && typeof v === "object" && !Array.isArray(v) && h && typeof h === "object" && !Array.isArray(h)) {
      if (subsetDiff(v as Record<string, unknown>, h as Record<string, unknown>)) return true;
    } else if (!configEqual(v, h)) {
      return true;
    }
  }
  return undefined;
}

/** Live env-var list (`[{ envVar: {key, value}, cursor }]` or bare) → key/value map. Pure. */
export function envVarsToMap(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const ev = item && typeof item === "object" && "envVar" in item ? (item as { envVar: unknown }).envVar : item;
    if (ev && typeof ev === "object") {
      const { key, value } = ev as { key?: unknown; value?: unknown };
      if (typeof key === "string") out[key] = typeof value === "string" ? value : "";
    }
  }
  return out;
}

/** Declared env-var list (`[{key, value} | {key, generateValue}]`) → key/value map (generated values as `undefined`). Pure. */
export function declaredEnvVarsToMap(list: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (item && typeof item === "object") {
      const { key, value } = item as { key?: unknown; value?: unknown };
      if (typeof key === "string") out[key] = typeof value === "string" ? value : undefined;
    }
  }
  return out;
}

/**
 * True when a live env-var map carries chant's ownership marker. Reads the key
 * convention the render lexicon declares (`RENDER_ENV_OWNERSHIP_KEYS`) through
 * core's `hasOwnershipMarker`, so the prune filter and the serializer's stamp
 * can never drift apart. Pure.
 */
export function isChantOwned(envVars: Record<string, string> | null | undefined): boolean {
  return hasOwnershipMarker(envVars ?? undefined, RENDER_ENV_OWNERSHIP_KEYS);
}

/** The stack/env identity a live env-var map carries, if marked. Pure. */
export function ownershipOf(envVars: Record<string, string> | null | undefined): OwnershipMarker | undefined {
  return readOwnership(envVars ?? undefined, RENDER_ENV_OWNERSHIP_KEYS);
}

/**
 * Whether a declared env-var set and a live one differ. Generated values
 * (`generateValue: true`) match any live value — Render made it up once and
 * chant must not regenerate it every run. Pure.
 */
export function envVarsDiffer(declared: unknown, live: Record<string, string>): boolean {
  const want = declaredEnvVarsToMap(declared);
  const wantKeys = Object.keys(want).sort();
  const haveKeys = Object.keys(live).sort();
  if (wantKeys.join(" ") !== haveKeys.join(" ")) return true;
  for (const k of wantKeys) {
    if (want[k] !== undefined && want[k] !== live[k]) return true;
  }
  return false;
}

/** The plan's ownership marker (from the first marked body), for scoping prune. Pure. */
export function planOwnership(plan: RenderPlan): OwnershipMarker | undefined {
  for (const req of Object.values(plan)) {
    const entry = CATALOG[req.entityType];
    if (!entry?.marked) continue;
    const map = declaredEnvVarsToMap(req.body.envVars);
    const managed = map[RENDER_ENV_OWNERSHIP_KEYS.managedBy];
    if (managed !== "chant") continue;
    return {
      stack: map[RENDER_ENV_OWNERSHIP_KEYS.stack] ?? "",
      env: map[RENDER_ENV_OWNERSHIP_KEYS.env],
    };
  }
  return undefined;
}

/**
 * Whether a live marked resource belongs to this plan's stack: same stack
 * (and env, when the plan names one). A plan with no stack identity (bare
 * `managed-by` only) owns every chant-marked resource in the workspace, which
 * is the pre-#119 single-stack behaviour and is what an unconfigured project
 * gets. Pure.
 */
export function inStack(live: OwnershipMarker | undefined, plan: OwnershipMarker | undefined): boolean {
  if (!live) return false;
  if (!plan || !plan.stack) return true;
  if (live.stack !== plan.stack) return false;
  if (plan.env && live.env !== plan.env) return false;
  return true;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export type RenderHttp = (
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

/**
 * Default `fetch`-based client. Sends `Authorization: Bearer <token>`; the
 * token defaults to `RENDER_API_KEY` at call time. Retries 429 (Render rate
 * limits at ~ 400 req/min) honouring `retry-after`, capped.
 */
export function defaultRenderHttp(token?: string): RenderHttp {
  return async (method, url, body, headers, signal) => {
    const h: Record<string, string> = { accept: "application/json", ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const tok = token ?? process.env.RENDER_API_KEY;
    if (tok) h["authorization"] = `Bearer ${tok}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (res.status === 429 && attempt < 5) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * (attempt + 1), signal);
        continue;
      }
      return { status: res.status, text: await res.text() };
    }
  };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fail(what: string, status: number, text: string): never {
  throw new Error(`render: ${what} failed (HTTP ${status}): ${text.slice(0, 500)}`);
}

export interface WaitOpts {
  /** Wait for a created service's first deploy to reach `live`. Default: true. */
  deploys?: boolean;
  /** Poll interval in ms. Default: 5000. */
  intervalMs?: number;
  /** Overall client deadline per deploy in ms. Default: 15 minutes. */
  deadlineMs?: number;
}

export interface ApplyCtx {
  base: string;
  ownerId?: string;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Unwrap a list envelope element (`{ service: {...}, cursor }`) to the resource. */
function unwrap(item: unknown, listKey: string | null): Record<string, unknown> | undefined {
  if (!item || typeof item !== "object") return undefined;
  if (listKey && listKey in (item as Record<string, unknown>)) {
    const inner = (item as Record<string, unknown>)[listKey];
    return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
  }
  return item as Record<string, unknown>;
}

/** GET every page of a list endpoint, following the cursor. */
export async function listAll(
  ctx: ApplyCtx,
  path: string,
  query: Record<string, string | undefined>,
  listKey: string | null,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, v);
    params.set("limit", String(PAGE_LIMIT));
    if (cursor) params.set("cursor", cursor);
    const res = await http("GET", `${ctx.base}${path}?${params.toString()}`, undefined, undefined, signal);
    if (res.status === 404 && page === 0) return out;
    if (res.status < 200 || res.status >= 300) fail(`GET ${path}`, res.status, res.text);
    const items = parseJson(res.text);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const r = unwrap(item, listKey);
      if (r) out.push(r);
    }
    const last = items[items.length - 1] as { cursor?: string };
    cursor = typeof last?.cursor === "string" ? last.cursor : undefined;
    if (items.length < PAGE_LIMIT || !cursor) break;
  }
  return out;
}

/** GET one resource by id. */
export async function getOne(
  ctx: ApplyCtx,
  path: string,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const res = await http("GET", `${ctx.base}${path}`, undefined, undefined, signal);
  if (res.status === 404) return undefined;
  if (res.status < 200 || res.status >= 300) fail(`GET ${path}`, res.status, res.text);
  const v = parseJson(res.text);
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/**
 * Resolve the workspace id: an explicit arg, then `RENDER_OWNER_ID`, then the
 * sole owner the token can see. Throws when the token sees several — picking
 * one silently would deploy into the wrong team.
 */
export async function resolveOwner(
  ctx: ApplyCtx,
  args: { ownerId?: string },
  http: RenderHttp,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (ctx.ownerId) return ctx.ownerId;
  const explicit = args.ownerId || env.RENDER_OWNER_ID;
  if (explicit) {
    ctx.ownerId = explicit;
    return explicit;
  }
  const owners = await listAll(ctx, "/owners", {}, "owner", http, signal);
  const ids = owners.map((o) => o.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 1) {
    ctx.ownerId = ids[0];
    return ids[0];
  }
  if (ids.length === 0) throw new Error("render: the API key sees no workspaces — set RENDER_OWNER_ID");
  throw new Error(
    `render: the API key sees ${ids.length} workspaces (${ids.join(", ")}) — set RENDER_OWNER_ID or pass ownerId to choose one`,
  );
}

/**
 * Find the live resource a request declares, by name within its scope.
 * Services also match on `type`; environments on `projectId`; disks on
 * `serviceId`; custom domains list under their service.
 */
export async function findExisting(
  ctx: ApplyCtx,
  req: RenderRequest,
  entry: CatalogEntry,
  endpoint: string,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const query: Record<string, string | undefined> = {};
  if (entry.filters.name) query.name = req.name;
  if (entry.filters.ownerId) query.ownerId = typeof req.body.ownerId === "string" ? req.body.ownerId : ctx.ownerId;
  if (req.entityType === ENTITY_TYPES.environment && typeof req.body.projectId === "string") {
    query.projectId = req.body.projectId;
  }
  if (req.entityType === ENTITY_TYPES.disk && typeof req.body.serviceId === "string") {
    query.serviceId = req.body.serviceId;
  }
  const listPath = req.entityType === ENTITY_TYPES.customDomain ? endpoint : entry.collection;
  const candidates = await listAll(ctx, listPath, query, entry.listKey, http, signal);
  return candidates.find((c) => {
    if (c.name !== req.name) return false;
    if (isServiceEntityType(req.entityType) && c.type !== req.body.type) return false;
    if (req.entityType === ENTITY_TYPES.environment && typeof req.body.projectId === "string" && c.projectId !== req.body.projectId) return false;
    if (req.entityType === ENTITY_TYPES.disk && typeof req.body.serviceId === "string" && c.serviceId !== req.body.serviceId) return false;
    return true;
  });
}

// ── Marker resolution ─────────────────────────────────────────────────────────

/** What the applier knows about an entity once it is live. */
export interface LiveEntity {
  id: string;
  entityType: string;
  resource: Record<string, unknown>;
}

/** Datastore attributes served by the `/connection-info` side endpoint. */
const CONNECTION_INFO_ATTRS = new Set([
  "internalConnectionString",
  "externalConnectionString",
  "psqlCommand",
  "cliCommand",
  "internalConnectionPoolString",
  "externalConnectionPoolString",
  "password",
]);

/**
 * Resolve an attribute of a live entity: `id`, any field of the live resource,
 * or a datastore connection-info field (fetched once per entity).
 */
export async function resolveAttribute(
  ctx: ApplyCtx,
  live: LiveEntity,
  attribute: string,
  http: RenderHttp,
  cache: Map<string, Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (attribute === "id") return live.id;
  if (attribute in live.resource) return live.resource[attribute];
  if (CONNECTION_INFO_ATTRS.has(attribute)) {
    const entry = catalogEntry(live.entityType);
    const key = `${entry.collection}/${live.id}`;
    let info = cache.get(key);
    if (!info) {
      info = (await getOne(ctx, `${entry.collection}/${live.id}/connection-info`, http, signal)) ?? {};
      cache.set(key, info);
    }
    if (attribute in info) return info[attribute];
  }
  throw new Error(`render: attribute "${attribute}" is not available on live ${live.entityType} ${live.id}`);
}

/** Replace every marker in a value with its live resolution. */
export async function resolveMarkers(
  ctx: ApplyCtx,
  value: unknown,
  lives: Map<string, LiveEntity>,
  http: RenderHttp,
  cache: Map<string, Record<string, unknown>>,
  ownerId: () => Promise<string>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (isOwnerMarker(value)) return ownerId();
  if (isRefMarker(value)) {
    const live = lives.get(value.$ref);
    if (!live) throw new Error(`render: reference to "${value.$ref}" cannot be resolved — it has not been applied`);
    return live.id;
  }
  if (isAttrMarker(value)) {
    const live = lives.get(value.$attr.entity);
    if (!live) throw new Error(`render: attribute read on "${value.$attr.entity}" cannot be resolved — it has not been applied`);
    return resolveAttribute(ctx, live, value.$attr.attribute, http, cache, signal);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await resolveMarkers(ctx, v, lives, http, cache, ownerId, signal));
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveMarkers(ctx, v, lives, http, cache, ownerId, signal);
    }
    return out;
  }
  return value;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** POST a create body; returns the created resource (services: unwrapped from `{ service, deployId }`). */
export async function create(
  ctx: ApplyCtx,
  endpoint: string,
  body: Record<string, unknown>,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<{ resource: Record<string, unknown>; deployId?: string }> {
  const res = await http("POST", `${ctx.base}${endpoint}`, body, undefined, signal);
  if (res.status < 200 || res.status >= 300) fail(`POST ${endpoint}`, res.status, res.text);
  const parsed = parseJson(res.text);
  // Custom domains answer with an array of the domains created.
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== "object") return { resource: {} };
  const rec = first as Record<string, unknown>;
  if (rec.service && typeof rec.service === "object") {
    return { resource: rec.service as Record<string, unknown>, deployId: typeof rec.deployId === "string" ? rec.deployId : undefined };
  }
  return { resource: rec };
}

/** PATCH a live resource; returns the updated resource. */
export async function patch(
  ctx: ApplyCtx,
  path: string,
  body: Record<string, unknown>,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await http("PATCH", `${ctx.base}${path}`, body, undefined, signal);
  if (res.status < 200 || res.status >= 300) fail(`PATCH ${path}`, res.status, res.text);
  const v = parseJson(res.text);
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** DELETE a live resource; false when it was already gone. */
export async function remove(
  ctx: ApplyCtx,
  path: string,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await http("DELETE", `${ctx.base}${path}`, undefined, undefined, signal);
  if (res.status === 404) return false;
  if (res.status < 200 || res.status >= 300) fail(`DELETE ${path}`, res.status, res.text);
  return true;
}

/** Live env vars of a service (`GET /services/{id}/env-vars`), as a map. */
export async function readServiceEnvVars(
  ctx: ApplyCtx,
  serviceId: string,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const items = await listAll(ctx, `/services/${serviceId}/env-vars`, {}, "envVar", http, signal);
  return envVarsToMap(items);
}

/** Replace a service's env vars wholesale (`PUT /services/{id}/env-vars`). */
export async function putServiceEnvVars(
  ctx: ApplyCtx,
  serviceId: string,
  envVars: unknown[],
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<void> {
  const res = await http("PUT", `${ctx.base}/services/${serviceId}/env-vars`, envVars, undefined, signal);
  if (res.status < 200 || res.status >= 300) fail(`PUT /services/${serviceId}/env-vars`, res.status, res.text);
}

/**
 * Reconcile an env group's env vars: Render's group PATCH takes only `name`,
 * so each var is PUT by key and removed keys are DELETEd. Returns whether
 * anything changed.
 */
export async function reconcileEnvGroupVars(
  ctx: ApplyCtx,
  groupId: string,
  declared: unknown,
  live: Record<string, string>,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<boolean> {
  const want = declaredEnvVarsToMap(declared);
  let changed = false;
  for (const [key, value] of Object.entries(want)) {
    if (value === undefined) {
      if (key in live) continue; // generated once; keep
      const res = await http("PUT", `${ctx.base}/env-groups/${groupId}/env-vars/${encodeURIComponent(key)}`, { generateValue: true }, undefined, signal);
      if (res.status < 200 || res.status >= 300) fail(`PUT env-group var ${key}`, res.status, res.text);
      changed = true;
      continue;
    }
    if (live[key] === value) continue;
    const res = await http("PUT", `${ctx.base}/env-groups/${groupId}/env-vars/${encodeURIComponent(key)}`, { value }, undefined, signal);
    if (res.status < 200 || res.status >= 300) fail(`PUT env-group var ${key}`, res.status, res.text);
    changed = true;
  }
  for (const key of Object.keys(live)) {
    if (key in want) continue;
    const res = await http("DELETE", `${ctx.base}/env-groups/${groupId}/env-vars/${encodeURIComponent(key)}`, undefined, undefined, signal);
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) fail(`DELETE env-group var ${key}`, res.status, res.text);
    changed = true;
  }
  return changed;
}

/** Link the declared services to an env group (`POST /env-groups/{id}/services/{serviceId}`). */
export async function linkEnvGroupServices(
  ctx: ApplyCtx,
  groupId: string,
  serviceIds: string[],
  live: Record<string, unknown>,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<boolean> {
  const linked = new Set<string>();
  const links = live.serviceLinks;
  if (Array.isArray(links)) {
    for (const l of links) {
      const id = (l as { id?: unknown })?.id;
      if (typeof id === "string") linked.add(id);
    }
  }
  let changed = false;
  for (const sid of serviceIds) {
    if (linked.has(sid)) continue;
    const res = await http("POST", `${ctx.base}/env-groups/${groupId}/services/${sid}`, undefined, undefined, signal);
    if (res.status < 200 || res.status >= 300) fail(`POST env-group link ${sid}`, res.status, res.text);
    changed = true;
  }
  return changed;
}

/** The latest deploy of a service, if any. */
export async function latestDeploy(
  ctx: ApplyCtx,
  serviceId: string,
  http: RenderHttp,
  signal?: AbortSignal,
): Promise<{ id: string; status: string } | undefined> {
  const res = await http("GET", `${ctx.base}/services/${serviceId}/deploys?limit=1`, undefined, undefined, signal);
  if (res.status < 200 || res.status >= 300) fail(`GET deploys ${serviceId}`, res.status, res.text);
  const items = parseJson(res.text);
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const d = unwrap(items[0], "deploy");
  if (!d || typeof d.id !== "string") return undefined;
  return { id: d.id, status: typeof d.status === "string" ? d.status : "" };
}

/**
 * Poll a service's deploy until it is `live`. Throws on a failed/canceled
 * deploy or when the deadline passes. When `deployId` is unknown, the latest
 * deploy is watched.
 */
export async function waitForDeploy(
  ctx: ApplyCtx,
  serviceId: string,
  deployId: string | undefined,
  opts: WaitOpts,
  http: RenderHttp,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<string> {
  const interval = opts.intervalMs ?? 5000;
  const deadline = now() + (opts.deadlineMs ?? 15 * 60 * 1000);
  for (;;) {
    let status: string;
    let id = deployId;
    if (id) {
      const d = await getOne(ctx, `/services/${serviceId}/deploys/${id}`, http, signal);
      status = typeof d?.status === "string" ? d.status : "";
    } else {
      const d = await latestDeploy(ctx, serviceId, http, signal);
      if (!d) return "no-deploy";
      id = d.id;
      status = d.status;
    }
    safeHeartbeat({ step: "renderApply", kind: "deploy", service: serviceId, deploy: id, status });
    if (DEPLOY_LIVE.has(status)) return status;
    if (DEPLOY_FAILED.has(status)) {
      throw new Error(`render: deploy ${id} of service ${serviceId} ended ${status}`);
    }
    if (now() >= deadline) {
      throw new Error(`render: deploy ${id} of service ${serviceId} still ${status || "pending"} after deadline`);
    }
    await sleep(interval, signal);
  }
}

// ── The applier ───────────────────────────────────────────────────────────────

export interface RenderApplyArgs {
  /** Path to the serializer's plan JSON. */
  planPath: string;
  /** API base URL override. Default: `RENDER_API_BASE_URL`, else api.render.com. */
  endpoint?: string;
  /** Bearer token. Default: `RENDER_API_KEY`. */
  token?: string;
  /** Workspace id for `$owner` markers. Default: `RENDER_OWNER_ID`, else the sole visible owner. */
  ownerId?: string;
  /**
   * Prune chant-owned services and env groups the plan no longer declares.
   * Owned = carries the `CHANT_MANAGED_BY=chant` env-var marker for this
   * plan's stack. Destructive — off by default.
   */
  prune?: boolean;
  /** Deploy wait tuning. */
  wait?: WaitOpts;
}

export interface RenderApplyOutcome {
  applied: Array<{ kind: string; name: string; action: "created" | "updated" | "unchanged"; id?: string; entity: string }>;
  pruned: Array<{ kind: string; name: string; id: string; deleted: boolean }>;
  notAttempted: NotAttemptedResource[];
}

/** Map an outcome onto core's versioned apply envelope. Pure. */
export function toApplyResult(outcome: RenderApplyOutcome): ApplyResult {
  const applied: AppliedResource[] = outcome.applied.map((a) => ({
    kind: a.kind,
    name: a.name,
    action: a.action,
    ...(a.id ? { physicalId: a.id } : {}),
  }));
  const pruned: PrunedResource[] = outcome.pruned.map((p) => ({ kind: p.kind, name: p.name, deleted: p.deleted }));
  return applyResult(applied, pruned, outcome.notAttempted);
}

/**
 * Apply a serialized Render plan: create or update every declared resource in
 * dependency order, resolving `$ref`/`$attr`/`$owner` markers as their targets
 * go live; wait each created service's deploy to `live`; prune owned orphans
 * when asked. Returns the versioned {@link ApplyResult}.
 */
export async function renderApply(
  args: RenderApplyArgs,
  signal?: AbortSignal,
  http: RenderHttp = defaultRenderHttp(args.token),
): Promise<ApplyResult> {
  const outcome = await renderApplyDetailed(args, signal, http);
  return toApplyResult(outcome);
}

export async function renderApplyDetailed(
  args: RenderApplyArgs,
  signal?: AbortSignal,
  http: RenderHttp = defaultRenderHttp(args.token),
): Promise<RenderApplyOutcome> {
  const plan = parsePlan(readFileSync(args.planPath, "utf8"));
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const wait = args.wait ?? {};
  const ordered = orderPlan(plan);
  const lives = new Map<string, LiveEntity>();
  const infoCache = new Map<string, Record<string, unknown>>();
  const owner = () => resolveOwner(ctx, args, http, signal);

  const outcome: RenderApplyOutcome = { applied: [], pruned: [], notAttempted: [] };

  for (const [entityName, req] of ordered) {
    const entry = catalogEntry(req.entityType);
    safeHeartbeat({ step: "renderApply", kind: entry.kind, name: req.name });

    // Resolve markers now that every dependency is live.
    const body = (await resolveMarkers(ctx, req.body, lives, http, infoCache, owner, signal)) as Record<string, unknown>;
    const pathParams = (await resolveMarkers(ctx, req.pathParams ?? {}, lives, http, infoCache, owner, signal)) as Record<string, unknown>;
    let endpoint = req.endpoint;
    for (const [k, v] of Object.entries(pathParams)) {
      if (typeof v === "string") endpoint = endpoint.replace(`{${k}}`, encodeURIComponent(v));
    }
    if (entry.filters.ownerId && typeof body.ownerId !== "string") {
      // A list filter needs the owner even when the body does not carry it.
      ctx.ownerId = ctx.ownerId ?? (await owner());
    }

    const existing = await findExisting(ctx, req, entry, endpoint, http, signal);

    if (!existing) {
      const { resource, deployId } = await create(ctx, endpoint, body, http, signal);
      const id = typeof resource.id === "string" ? resource.id : "";
      lives.set(entityName, { id, entityType: req.entityType, resource });
      console.log(`created: ${entry.kind}/${req.name}${id ? ` (${id})` : ""}`);
      // Env-group service links are not part of the create body.
      if (req.entityType === ENTITY_TYPES.envGroup && Array.isArray(body.serviceIds) && id) {
        await linkEnvGroupServices(ctx, id, body.serviceIds.filter((s): s is string => typeof s === "string"), resource, http, signal);
      }
      if (isServiceEntityType(req.entityType) && id && wait.deploys !== false) {
        await waitForDeploy(ctx, id, deployId, wait, http, signal);
      }
      outcome.applied.push({ kind: entry.kind, name: req.name, action: "created", id, entity: entityName });
      continue;
    }

    const id = typeof existing.id === "string" ? existing.id : "";
    lives.set(entityName, { id, entityType: req.entityType, resource: existing });
    let changed = false;

    // Body PATCH — the catalog's patchable fields that differ.
    const diff = entry.patchable ? diffForPatch(entry, body, existing) : undefined;
    if (diff && id) {
      const updated = await patch(ctx, `${entry.collection}/${id}`, diff, http, signal);
      lives.set(entityName, { id, entityType: req.entityType, resource: { ...existing, ...updated } });
      changed = true;
    }

    // Env vars: services replace wholesale via PUT; env groups per key.
    if (entry.marked && id) {
      if (isServiceEntityType(req.entityType)) {
        const live = await readServiceEnvVars(ctx, id, http, signal);
        if (envVarsDiffer(body.envVars, live)) {
          // Keep live values for generated keys so Render's random values survive.
          const desired = (Array.isArray(body.envVars) ? body.envVars : []).map((e) => {
            const item = e as { key: string; value?: string; generateValue?: boolean };
            if (item.generateValue && item.key in live) return { key: item.key, value: live[item.key] };
            return item;
          });
          await putServiceEnvVars(ctx, id, desired, http, signal);
          changed = true;
        }
      } else if (req.entityType === ENTITY_TYPES.envGroup) {
        const live = envVarsToMap(existing.envVars);
        if (await reconcileEnvGroupVars(ctx, id, body.envVars, live, http, signal)) changed = true;
        if (Array.isArray(body.serviceIds)) {
          const linked = await linkEnvGroupServices(ctx, id, body.serviceIds.filter((s): s is string => typeof s === "string"), existing, http, signal);
          if (linked) changed = true;
        }
      }
    }

    console.log(`${changed ? "updated" : "unchanged"}: ${entry.kind}/${req.name} (${id})`);
    outcome.applied.push({ kind: entry.kind, name: req.name, action: changed ? "updated" : "unchanged", id, entity: entityName });
  }

  // Prune: owned services and env groups (marked, this stack) not in the plan,
  // and — at the service boundary — the disks and custom domains under an
  // owned service that the plan does not declare.
  if (args.prune) {
    const ownerId = await owner();
    const marker = planOwnership(plan);
    const declaredServices = new Set(
      ordered.filter(([, r]) => isServiceEntityType(r.entityType)).map(([, r]) => `${r.body.type}:${r.name}`),
    );
    const declaredGroups = new Set(ordered.filter(([, r]) => r.entityType === ENTITY_TYPES.envGroup).map(([, r]) => r.name));
    // Declared children by `${serviceId}:${name}`, with the parent's live id.
    const declaredChildren = new Set<string>();
    for (const [, r] of ordered) {
      const entry = catalogEntry(r.entityType);
      if (entry.boundary !== "service") continue;
      const raw = r.entityType === ENTITY_TYPES.customDomain ? r.pathParams?.serviceId : r.body.serviceId;
      const parentId = isRefMarker(raw) ? lives.get(raw.$ref)?.id : typeof raw === "string" ? raw : undefined;
      if (parentId) declaredChildren.add(`${parentId}:${r.name}`);
    }

    // Owned services first (declared or not): their undeclared children go,
    // then the undeclared services themselves.
    const staleServices: Array<{ id: string; name: string; type: string }> = [];
    for (const svc of await listAll(ctx, "/services", { ownerId }, "service", http, signal)) {
      const id = typeof svc.id === "string" ? svc.id : undefined;
      const name = typeof svc.name === "string" ? svc.name : "";
      const type = typeof svc.type === "string" ? svc.type : "";
      if (!id) continue;
      const env = await readServiceEnvVars(ctx, id, http, signal);
      if (!isChantOwned(env) || !inStack(ownershipOf(env), marker)) continue;
      const declared = declaredServices.has(`${type}:${name}`);
      if (!declared) staleServices.push({ id, name, type });

      // Service boundary: disks and custom domains under this owned service.
      // A stale service takes its children with it, so only a declared parent
      // needs its children reconciled one by one.
      if (!declared) continue;
      for (const disk of await listAll(ctx, "/disks", { serviceId: id, ownerId }, "disk", http, signal)) {
        const diskId = typeof disk.id === "string" ? disk.id : undefined;
        const diskName = typeof disk.name === "string" ? disk.name : "";
        if (!diskId || disk.serviceId !== id || declaredChildren.has(`${id}:${diskName}`)) continue;
        const deleted = await remove(ctx, `/disks/${diskId}`, http, signal);
        console.log(`pruned: Disk/${diskName} (${diskId}) under ${type}/${name}`);
        outcome.pruned.push({ kind: "Disk", name: diskName, id: diskId, deleted });
      }
      for (const domain of await listAll(ctx, `/services/${id}/custom-domains`, {}, "customDomain", http, signal)) {
        const domainId = typeof domain.id === "string" ? domain.id : undefined;
        const domainName = typeof domain.name === "string" ? domain.name : "";
        if (!domainId || declaredChildren.has(`${id}:${domainName}`)) continue;
        const deleted = await remove(ctx, `/services/${id}/custom-domains/${encodeURIComponent(domainId)}`, http, signal);
        console.log(`pruned: CustomDomain/${domainName} (${domainId}) under ${type}/${name}`);
        outcome.pruned.push({ kind: "CustomDomain", name: domainName, id: domainId, deleted });
      }
    }
    for (const { id, name, type } of staleServices) {
      const kind = catalogEntry(ENTITY_TYPE_OF_SERVICE[type] ?? ENTITY_TYPES.webService).kind;
      const deleted = await remove(ctx, `/services/${id}`, http, signal);
      console.log(`pruned: ${kind}/${name} (${id})`);
      outcome.pruned.push({ kind, name, id, deleted });
    }
    for (const grp of await listAll(ctx, "/env-groups", { ownerId }, "envGroup", http, signal)) {
      const id = typeof grp.id === "string" ? grp.id : undefined;
      const name = typeof grp.name === "string" ? grp.name : "";
      if (!id || declaredGroups.has(name)) continue;
      const full = (await getOne(ctx, `/env-groups/${id}`, http, signal)) ?? grp;
      const env = envVarsToMap(full.envVars);
      if (!isChantOwned(env) || !inStack(ownershipOf(env), marker)) continue;
      const deleted = await remove(ctx, `/env-groups/${id}`, http, signal);
      console.log(`pruned: EnvGroup/${name} (${id})`);
      outcome.pruned.push({ kind: "EnvGroup", name, id, deleted });
    }
  }

  return outcome;
}

/**
 * Delete every resource a plan declares, in reverse apply order — the
 * teardown twin of {@link renderApply}. Looks each up by name; a resource that
 * is already gone is reported `deleted: false`. Only what the plan names is
 * touched.
 */
export async function renderDelete(
  args: RenderApplyArgs,
  signal?: AbortSignal,
  http: RenderHttp = defaultRenderHttp(args.token),
): Promise<ApplyResult> {
  const plan = parsePlan(readFileSync(args.planPath, "utf8"));
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const ordered = orderPlan(plan).reverse();
  const owner = () => resolveOwner(ctx, args, http, signal);
  const pruned: PrunedResource[] = [];
  const notAttempted: NotAttemptedResource[] = [];

  // Ids of entities we find, so a child endpoint's `{serviceId}` can resolve
  // even though we walk in reverse: resolve parents lazily by name.
  const idByEntity = new Map<string, string>();
  const findId = async (entityName: string): Promise<string | undefined> => {
    if (idByEntity.has(entityName)) return idByEntity.get(entityName);
    const req = plan[entityName];
    if (!req) return undefined;
    const entry = catalogEntry(req.entityType);
    if (entry.filters.ownerId) ctx.ownerId = ctx.ownerId ?? (await owner());
    const endpoint = await resolveEndpointFor(req);
    if (!endpoint) return undefined;
    const body = { ...req.body };
    if (isOwnerMarker(body.ownerId)) body.ownerId = await owner();
    const found = await findExisting(ctx, { ...req, body }, entry, endpoint, http, signal);
    const id = typeof found?.id === "string" ? found.id : undefined;
    if (id) idByEntity.set(entityName, id);
    return id;
  };
  const resolveEndpointFor = async (req: RenderRequest): Promise<string | undefined> => {
    let endpoint = req.endpoint;
    for (const [k, v] of Object.entries(req.pathParams ?? {})) {
      const id = isRefMarker(v) ? await findId(v.$ref) : typeof v === "string" ? v : undefined;
      if (!id) return undefined;
      endpoint = endpoint.replace(`{${k}}`, encodeURIComponent(id));
    }
    return endpoint;
  };

  for (const [entityName, req] of ordered) {
    const entry = catalogEntry(req.entityType);
    safeHeartbeat({ step: "renderDelete", kind: entry.kind, name: req.name });
    const endpoint = await resolveEndpointFor(req);
    const id = endpoint ? await findId(entityName) : undefined;
    if (!id) {
      pruned.push({ kind: entry.kind, name: req.name, deleted: false });
      continue;
    }
    // Custom domains delete under their service; everything else at its collection.
    const path = req.entityType === ENTITY_TYPES.customDomain ? `${endpoint}/${encodeURIComponent(id)}` : `${entry.collection}/${id}`;
    const deleted = await remove(ctx, path, http, signal);
    console.log(`${deleted ? "deleted" : "already gone"}: ${entry.kind}/${req.name} (${id})`);
    pruned.push({ kind: entry.kind, name: req.name, deleted });
  }

  return applyResult([], pruned, notAttempted);
}
