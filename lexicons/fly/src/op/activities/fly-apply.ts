/**
 * fly (Machines API / "flaps") native applier — #739.
 *
 * Peer of `gcpApply` (#706): a direct-REST applier that does its own diff,
 * owned-only prune, and mutation waiting. GCP has no server-side declarative
 * apply, and neither does flaps, so this loop is hand-rolled — GET-then-
 * create/update per resource, poll `/wait` after each mutation, and prune only
 * what chant owns. Unlike GCP's long-running operations, flaps gates mutations
 * behind machine leases (a nonce echoed in the `fly-machine-lease-nonce`
 * header), so the tricky paths here are the lease-conflict retry and waiting on
 * the correct new `instance_id` after an update.
 *
 * Input is the #738 serializer's output: a JSON object keyed by entity name,
 * each value a single flaps create request `{ endpoint, method, body }` (app →
 * `/v1/apps`, machine → `/v1/apps/{app}/machines`). A machine endpoint may carry
 * a literal `{app}` placeholder when the stack declares more than one app; it is
 * resolved from the owning app at apply time.
 *
 * D1: direct REST, no flyctl, no state file. D2: owned-only prune via the
 * `managed-by: chant` machine metadata. D3: endpoint override via
 * `FLY_FLAPS_BASE_URL` (or an explicit `endpoint` arg), so the same code points
 * at real Fly or at mudflaps (`:4280`).
 */

import { readFileSync } from "node:fs";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

/** Default flaps host when neither an `endpoint` arg nor `FLY_FLAPS_BASE_URL` is set. */
export const DEFAULT_FLAPS_BASE_URL = "https://api.machines.dev";

/** Header carrying a lease nonce on a mutating request, matching fly-go/flaps. */
export const LEASE_NONCE_HEADER = "fly-machine-lease-nonce";

/** Machine `config.metadata` key that marks chant ownership (D2). */
const OWNERSHIP_KEY = "managed-by";
const OWNERSHIP_VALUE = "chant";

/** One flaps REST call as emitted by the #738 serializer. */
export interface FlapsRequest {
  endpoint: string;
  method: string;
  body: Record<string, unknown>;
}

/** The serializer's whole output: entity name → flaps create request. */
export type FlyPlan = Record<string, FlapsRequest>;

/** The subset of a live flaps machine the applier reads back. */
export interface FlapsMachine {
  id: string;
  name: string;
  state: string;
  instance_id: string;
  config?: { metadata?: Record<string, string> } & Record<string, unknown>;
}

// ── Pure helpers (unit-testable without http) ─────────────────────────────────

/**
 * Resolve the flaps base URL (D3): an explicit `endpoint` arg wins, then the
 * `FLY_FLAPS_BASE_URL` env, then the real-Fly default. The trailing slash is
 * stripped so `${base}/v1/...` never doubles up. Pure.
 */
export function resolveEndpoint(
  args: { endpoint?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = args.endpoint || env.FLY_FLAPS_BASE_URL || DEFAULT_FLAPS_BASE_URL;
  return base.replace(/\/$/, "");
}

/** Parse the serializer's JSON output into a plan. Pure. */
export function parsePlan(content: string): FlyPlan {
  return JSON.parse(content) as FlyPlan;
}

/** True when a request creates an App (`POST /v1/apps`). Pure. */
export function isAppRequest(req: FlapsRequest): boolean {
  return /^\/v1\/apps\/?$/.test(req.endpoint);
}

/** True when a request creates a Machine (`.../machines`). Pure. */
export function isMachineRequest(req: FlapsRequest): boolean {
  return /^\/v1\/apps\/[^/]+\/machines\/?$/.test(req.endpoint);
}

/** The app segment of a machine endpoint, or the literal `{app}` placeholder. Pure. */
export function machineAppSegment(endpoint: string): string {
  const m = endpoint.match(/^\/v1\/apps\/([^/]+)\/machines\/?$/);
  if (!m) throw new Error(`not a machine endpoint: ${endpoint}`);
  return decodeURIComponent(m[1]);
}

/**
 * Resolve a machine's owning app: the endpoint segment as-is, unless it is the
 * `{app}` placeholder the serializer leaves when it can't decide — then fall
 * back to the stack's sole app. Throws when neither settles it. Pure.
 */
export function resolveApp(segment: string, soleApp: string | undefined): string {
  if (segment !== "{app}") return segment;
  if (soleApp) return soleApp;
  throw new Error("machine endpoint has an unresolved {app} placeholder and the stack declares no single app");
}

/** The `app_name` an app request creates. Pure. */
export function appNameFromRequest(req: FlapsRequest): string {
  const name = req.body.app_name;
  if (typeof name !== "string" || !name) throw new Error("app request has no app_name");
  return name;
}

/** True when a machine's live metadata carries chant's ownership marker (D2). Pure. */
export function isChantOwned(metadata: Record<string, string> | null | undefined): boolean {
  return metadata?.[OWNERSHIP_KEY] === OWNERSHIP_VALUE;
}

/** Structural equality over two config values, order-insensitive. Pure. */
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
 * The lease-conflict retry decision. A 409 whose body mentions a lease is a
 * stale/lost nonce (the `lease_currently_held` acquire envelope, or the "machine
 * is leased" gate on a mutation) — the caller should re-acquire and retry once.
 * A 409 that is not lease-shaped (e.g. "app already exists") is not retried. Pure.
 */
export function isLeaseConflict(status: number, text: string): boolean {
  return status === 409 && /lease/i.test(text);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pull the nonce out of a lease-acquire success envelope. */
function parseNonce(text: string): string | undefined {
  const body = parseJson(text) as { data?: { nonce?: string } } | undefined;
  return body?.data?.nonce;
}

function parseMachine(text: string): FlapsMachine {
  const m = parseJson(text) as FlapsMachine | undefined;
  if (!m?.id) throw new Error(`unexpected machine response: ${text}`);
  return m;
}

// ── URL builders ──────────────────────────────────────────────────────────────

const appsUrl = (base: string): string => `${base}/v1/apps`;
const appUrl = (base: string, app: string): string => `${appsUrl(base)}/${encodeURIComponent(app)}`;
const machinesUrl = (base: string, app: string): string => `${appUrl(base, app)}/machines`;
const machineUrl = (base: string, app: string, id: string): string =>
  `${machinesUrl(base, app)}/${encodeURIComponent(id)}`;
const leaseUrl = (base: string, app: string, id: string): string => `${machineUrl(base, app, id)}/lease`;

function waitUrl(base: string, app: string, id: string, state: string, version: string, timeoutSecs: number): string {
  const q = new URLSearchParams({ state, timeout: String(timeoutSecs) });
  if (version) q.set("version", version);
  return `${machineUrl(base, app, id)}/wait?${q.toString()}`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

/**
 * Injectable HTTP client — mirrors gcp-apply's `GcpHttp`, extended with a
 * per-call `headers` map so the applier can carry the `fly-machine-lease-nonce`
 * header on a mutation (and so tests can assert it). Tests inject a fake; the
 * default hits `fetch`.
 */
export type FlyHttp = (
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

/**
 * Default `fetch`-based client. Sends `Authorization: Bearer <token>` when a
 * token is set (real Fly); mudflaps ignores it. The token defaults to
 * `FLY_API_TOKEN` at call time.
 */
export function defaultFlyHttp(token?: string): FlyHttp {
  return async (method, url, body, headers, signal) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const tok = token ?? process.env.FLY_API_TOKEN;
    if (tok) h["authorization"] = `Bearer ${tok}`;
    const res = await fetch(url, {
      method,
      headers: Object.keys(h).length ? h : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return { status: res.status, text: await res.text() };
  };
}

/** Wait-loop tuning. Defaults suit real flaps; tests shrink the interval. */
export interface WaitOpts {
  /** Server-side long-poll cap per request (clamped to 60s by flaps). */
  timeoutSecs?: number;
  /** Delay between re-polls after a non-terminal response. */
  intervalMs?: number;
  /** Overall client deadline across re-polls. */
  deadlineMs?: number;
}

export interface ApplyCtx {
  base: string;
}

// ── Leases (the crown-jewel path) ────────────────────────────────────────────

/**
 * Acquire a lease, retrying once on a lease-conflict 409. The retry is what
 * lets a stale/lost hold clear (the prior lease expired or was released) before
 * the mutation goes out with a fresh nonce. Returns the nonce.
 */
export async function acquireLease(
  ctx: ApplyCtx,
  app: string,
  id: string,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<string> {
  const url = leaseUrl(ctx.base, app, id);
  const body = { ttl: 60, description: "chant apply" };
  let res = await http("POST", url, body, undefined, signal);
  if (isLeaseConflict(res.status, res.text)) {
    res = await http("POST", url, body, undefined, signal);
  }
  if (res.status >= 300) {
    throw new Error(`lease acquire failed for ${app}/${id} (${res.status}): ${res.text}`);
  }
  const nonce = parseNonce(res.text);
  if (!nonce) throw new Error(`lease acquire returned no nonce for ${app}/${id}: ${res.text}`);
  return nonce;
}

/** Best-effort lease release. A cleared lease (post-destroy) 404s — ignored. */
export async function releaseLease(
  ctx: ApplyCtx,
  app: string,
  id: string,
  nonce: string,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await http("DELETE", leaseUrl(ctx.base, app, id), undefined, { [LEASE_NONCE_HEADER]: nonce }, signal);
  } catch {
    // Release is best-effort; a leaked lease expires on its TTL.
  }
}

/**
 * Run a lease-gated mutation: acquire → mutate (nonce in the header) → release.
 * On a lease-conflict 409 from the mutation (a stale/lost nonce), re-acquire a
 * fresh nonce and retry the mutation once. `mutate` receives the nonce so the
 * caller can put it in the header; it returns the raw response. Returns the
 * final mutation response.
 */
export async function withLease(
  ctx: ApplyCtx,
  app: string,
  id: string,
  http: FlyHttp,
  signal: AbortSignal | undefined,
  mutate: (nonce: string) => Promise<{ status: number; text: string }>,
): Promise<{ status: number; text: string }> {
  let nonce = await acquireLease(ctx, app, id, http, signal);
  try {
    let res = await mutate(nonce);
    if (isLeaseConflict(res.status, res.text)) {
      nonce = await acquireLease(ctx, app, id, http, signal);
      res = await mutate(nonce);
    }
    return res;
  } finally {
    await releaseLease(ctx, app, id, nonce, http, signal);
  }
}

// ── Wait ───────────────────────────────────────────────────────────────────────

/**
 * Poll `GET .../wait` until the machine reaches `state` at the given `version`
 * (its new `instance_id`). flaps clamps its own timeout to 60s and answers 408
 * on expiry, so the client re-polls until its own deadline. A destroyed+reaped
 * machine satisfies a `state=destroyed` wait (flaps returns `ok` on the missing
 * machine). `http` and the interval are injectable so tests avoid real waits.
 */
export async function waitForMachine(
  ctx: ApplyCtx,
  app: string,
  id: string,
  version: string,
  http: FlyHttp,
  signal?: AbortSignal,
  opts: WaitOpts & { state?: string } = {},
): Promise<void> {
  const state = opts.state ?? "started";
  const timeoutSecs = opts.timeoutSecs ?? 60;
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 300_000);
  const url = waitUrl(ctx.base, app, id, state, version, timeoutSecs);

  let attempt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("waitForMachine aborted");
    attempt++;
    safeHeartbeat({ step: "waitForMachine", app, id, attempt });
    const res = await http("GET", url, undefined, undefined, signal);
    if (res.status === 200 && (parseJson(res.text) as { ok?: boolean })?.ok === true) {
      return;
    }
    if (res.status === 200 || res.status === 408) {
      // Not settled yet (or the server-side long-poll timed out) — re-poll.
      await sleep(interval, signal);
      continue;
    }
    throw new Error(`wait failed for ${app}/${id} (${res.status}): ${res.text}`);
  }
  throw new Error(`machine ${app}/${id} did not reach ${state} within the deadline`);
}

// ── Resource operations ────────────────────────────────────────────────────────

/** Create the app if absent (idempotent). A create-time conflict means it exists. */
export async function applyApp(
  ctx: ApplyCtx,
  req: FlapsRequest,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<{ app: string; created: boolean }> {
  const app = appNameFromRequest(req);
  const get = await http("GET", appUrl(ctx.base, app), undefined, undefined, signal);
  if (get.status === 200) return { app, created: false };
  if (get.status !== 404) throw new Error(`app ${app} lookup failed (${get.status}): ${get.text}`);

  const res = await http("POST", appsUrl(ctx.base), req.body, undefined, signal);
  if (res.status === 409) return { app, created: false }; // already exists (raced)
  if (res.status >= 300) throw new Error(`app ${app} create failed (${res.status}): ${res.text}`);
  return { app, created: true };
}

/** List an app's live machines. */
export async function listMachines(
  ctx: ApplyCtx,
  app: string,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<FlapsMachine[]> {
  const res = await http("GET", machinesUrl(ctx.base, app), undefined, undefined, signal);
  if (res.status === 404) return [];
  if (res.status >= 300) throw new Error(`machine list failed for ${app} (${res.status}): ${res.text}`);
  const list = parseJson(res.text);
  return Array.isArray(list) ? (list as FlapsMachine[]) : [];
}

/**
 * Reconcile one machine: create it when absent; when present, update it only if
 * its config drifted (else no-op). A create/update is followed by a wait on the
 * machine's new `instance_id`. Updates go through a lease. The declared machine
 * is identified by name (falling back to the plan entity name), so re-applying
 * an unchanged machine is a no-op.
 */
export async function applyMachine(
  ctx: ApplyCtx,
  app: string,
  entityName: string,
  req: FlapsRequest,
  http: FlyHttp,
  signal?: AbortSignal,
  opts: WaitOpts = {},
): Promise<{ action: "created" | "updated" | "noop"; id: string; name: string }> {
  const name = typeof req.body.name === "string" && req.body.name ? req.body.name : entityName;
  const body = { ...req.body, name };
  const desiredConfig = req.body.config;

  const live = (await listMachines(ctx, app, http, signal)).find((m) => m.name === name);

  if (!live) {
    const res = await http("POST", machinesUrl(ctx.base, app), body, undefined, signal);
    if (res.status >= 300) throw new Error(`machine ${app}/${name} create failed (${res.status}): ${res.text}`);
    const m = parseMachine(res.text);
    await waitForMachine(ctx, app, m.id, m.instance_id, http, signal, opts);
    return { action: "created", id: m.id, name };
  }

  if (configEqual(desiredConfig, live.config)) {
    return { action: "noop", id: live.id, name };
  }

  const res = await withLease(ctx, app, live.id, http, signal, (nonce) =>
    http("POST", machineUrl(ctx.base, app, live.id), body, { [LEASE_NONCE_HEADER]: nonce }, signal),
  );
  if (res.status >= 300) throw new Error(`machine ${app}/${name} update failed (${res.status}): ${res.text}`);
  const m = parseMachine(res.text);
  await waitForMachine(ctx, app, m.id, m.instance_id, http, signal, opts);
  return { action: "updated", id: m.id, name };
}

/** Lease → destroy → wait for the machine to be reaped. */
export async function destroyMachine(
  ctx: ApplyCtx,
  app: string,
  id: string,
  http: FlyHttp,
  signal?: AbortSignal,
  opts: WaitOpts = {},
): Promise<void> {
  const res = await withLease(ctx, app, id, http, signal, (nonce) =>
    http("DELETE", machineUrl(ctx.base, app, id), undefined, { [LEASE_NONCE_HEADER]: nonce }, signal),
  );
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`machine ${app}/${id} destroy failed (${res.status}): ${res.text}`);
  }
  await waitForMachine(ctx, app, id, "", http, signal, { ...opts, state: "destroyed" });
}

/** Delete an app (idempotent; a 404 means it is already gone). */
export async function deleteApp(
  ctx: ApplyCtx,
  app: string,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<{ app: string; deleted: boolean }> {
  const res = await http("DELETE", appUrl(ctx.base, app), undefined, undefined, signal);
  if (res.status === 404) return { app, deleted: false };
  if (res.status >= 300) throw new Error(`app ${app} delete failed (${res.status}): ${res.text}`);
  return { app, deleted: true };
}

/**
 * Owned-only prune (D2): for one app, destroy the chant-owned machines whose
 * name is not in `keep`. An unmarked machine (no `managed-by: chant`) is never
 * touched, so it survives an apply that would otherwise delete it. Machines
 * already tearing down are skipped.
 */
export async function pruneMachines(
  ctx: ApplyCtx,
  app: string,
  keep: Set<string>,
  http: FlyHttp,
  signal?: AbortSignal,
  opts: WaitOpts = {},
): Promise<Array<{ app: string; name: string; id: string }>> {
  const pruned: Array<{ app: string; name: string; id: string }> = [];
  for (const m of await listMachines(ctx, app, http, signal)) {
    if (!isChantOwned(m.config?.metadata) || keep.has(m.name)) continue;
    if (m.state === "destroyed" || m.state === "destroying") continue;
    safeHeartbeat({ step: "pruneMachine", app, name: m.name });
    await destroyMachine(ctx, app, m.id, http, signal, opts);
    console.log(`pruned: ${app}/${m.name} (${ctx.base})`);
    pruned.push({ app, name: m.name, id: m.id });
  }
  return pruned;
}

// ── Top-level applier ──────────────────────────────────────────────────────────

export interface FlyApplyArgs {
  /** Path to the #738 serializer's JSON output (entity name → flaps request). */
  planPath: string;
  /** flaps endpoint override (D3). Default: `FLY_FLAPS_BASE_URL` env, else real Fly. */
  endpoint?: string;
  /** Bearer token for real Fly. Default: `FLY_API_TOKEN`. mudflaps ignores it. */
  token?: string;
  /**
   * Owned-only prune (D2): destroy chant-owned machines in a declared app that
   * are no longer declared. Destructive — off by default. Never touches an
   * unmarked (foreign) machine.
   */
  prune?: boolean;
  /** Wait-loop tuning (mainly for tests). */
  wait?: WaitOpts;
}

/**
 * The native fly applier (#739): read the serialized plan and apply it straight
 * to flaps in dependency order — app → (volumes, #741) → machines — then
 * optionally owned-only prune. `http` is injectable for tests.
 */
export async function flyApply(
  args: FlyApplyArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{
  apps: Array<{ app: string; created: boolean }>;
  machines: Array<{ app: string; name: string; action: "created" | "updated" | "noop" }>;
  pruned: Array<{ app: string; name: string; id: string }>;
}> {
  const plan = parsePlan(readFileSync(args.planPath, "utf8"));
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const opts = args.wait ?? {};

  const appReqs: FlapsRequest[] = [];
  const machineReqs: Array<[string, FlapsRequest]> = [];
  for (const [entityName, req] of Object.entries(plan)) {
    if (isAppRequest(req)) appReqs.push(req);
    else if (isMachineRequest(req)) machineReqs.push([entityName, req]);
    // Other resource types (volumes/IPs/certs/secrets) land in #741.
  }

  const appNames = appReqs.map(appNameFromRequest);
  const soleApp = appNames.length === 1 ? appNames[0] : undefined;

  // Apps first.
  const apps: Array<{ app: string; created: boolean }> = [];
  for (const req of appReqs) {
    safeHeartbeat({ step: "flyApply", kind: "app", name: appNameFromRequest(req) });
    const result = await applyApp(ctx, req, http, signal);
    console.log(`${result.created ? "created" : "unchanged"}: app/${result.app} (${ctx.base})`);
    apps.push(result);
  }

  // #741 hook: volumes are applied here, between apps and machines, so a machine
  // that mounts a volume finds it already provisioned.

  // Seed the keep-set with every declared app (empty), so an app whose machines
  // were all removed still prunes them.
  const declaredByApp = new Map<string, Set<string>>();
  for (const app of appNames) declaredByApp.set(app, new Set<string>());

  const machines: Array<{ app: string; name: string; action: "created" | "updated" | "noop" }> = [];
  for (const [entityName, req] of machineReqs) {
    const app = resolveApp(machineAppSegment(req.endpoint), soleApp);
    const name = typeof req.body.name === "string" && req.body.name ? req.body.name : entityName;
    const keep = declaredByApp.get(app) ?? new Set<string>();
    keep.add(name);
    declaredByApp.set(app, keep);
    safeHeartbeat({ step: "flyApply", kind: "machine", name });
    const result = await applyMachine(ctx, app, entityName, req, http, signal, opts);
    console.log(`${result.action}: machine/${app}/${result.name} (${ctx.base})`);
    machines.push({ app, name: result.name, action: result.action });
  }

  const pruned: Array<{ app: string; name: string; id: string }> = [];
  if (args.prune) {
    for (const [app, keep] of declaredByApp) {
      pruned.push(...(await pruneMachines(ctx, app, keep, http, signal, opts)));
    }
  }

  return { apps, machines, pruned };
}

/**
 * The inverse of {@link flyApply}: destroy the machines the plan declares, then
 * delete the apps (dependents before their app). Idempotent — already-absent
 * resources are a no-op. `http` is injectable for tests.
 */
export async function flyDelete(
  args: FlyApplyArgs,
  signal?: AbortSignal,
  http: FlyHttp = defaultFlyHttp(args.token),
): Promise<{ machines: Array<{ app: string; name: string }>; apps: Array<{ app: string; deleted: boolean }> }> {
  const plan = parsePlan(readFileSync(args.planPath, "utf8"));
  const ctx: ApplyCtx = { base: resolveEndpoint(args) };
  const opts = args.wait ?? {};

  const appReqs: FlapsRequest[] = [];
  const machineReqs: Array<[string, FlapsRequest]> = [];
  for (const [entityName, req] of Object.entries(plan)) {
    if (isAppRequest(req)) appReqs.push(req);
    else if (isMachineRequest(req)) machineReqs.push([entityName, req]);
  }
  const soleApp = appReqs.length === 1 ? appNameFromRequest(appReqs[0]) : undefined;

  const machines: Array<{ app: string; name: string }> = [];
  for (const [entityName, req] of machineReqs) {
    const app = resolveApp(machineAppSegment(req.endpoint), soleApp);
    const name = typeof req.body.name === "string" && req.body.name ? req.body.name : entityName;
    const live = (await listMachines(ctx, app, http, signal)).find((m) => m.name === name);
    if (!live) continue;
    safeHeartbeat({ step: "flyDelete", kind: "machine", name });
    await destroyMachine(ctx, app, live.id, http, signal, opts);
    machines.push({ app, name });
  }

  const apps: Array<{ app: string; deleted: boolean }> = [];
  for (const req of appReqs) {
    const result = await deleteApp(ctx, appNameFromRequest(req), http, signal);
    console.log(`${result.deleted ? "deleted" : "absent"}: app/${result.app} (${ctx.base})`);
    apps.push(result);
  }

  return { machines, apps };
}
