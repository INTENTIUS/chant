/**
 * Sprite Services activities (#2711) — imperative create/get/list/start/stop/
 * delete/logs over a Sprite's background services, the surface a box's door
 * and hud run as long-lived services through (`sprite-env services`
 * inside the sprite, `/v1/sprites/{id}/services/...` outside). Shared by the
 * Sprites API, wisp (arugula-salad/wisp) and spritzer 0.6.0's container mode
 * (INTENTIUS/spritzer#22).
 *
 * This is the imperative twin of `sprite-config.ts`'s `spriteApplyServices` —
 * that one reconciles a whole desired service *set* (additive create-or-update,
 * optionally started, no delete). These activities are the single-service
 * primitives underneath it: create-and-start one service and watch it come
 * up, inspect or list what's running, stop/start one by name, delete it, and
 * read its log tail. An Op that provisions a box one service at a time (or
 * needs delete, which `spriteApplyServices` doesn't expose) uses these
 * directly; `spriteApplyServices` stays the batch-reconcile convenience on
 * top of the same wire shapes.
 *
 * `spriteServiceCreate` is a `PUT` that both defines the service and starts
 * it, streaming NDJSON progress (`started`, `stdout`, `stderr`, `exit`,
 * `complete`) for a bounded `?duration` window (default 500ms — enough to
 * surface an immediate failure, e.g. a missing binary, without holding the
 * step open for spritzer's own 5s default). The stream is read to completion
 * either way; the definitive result comes from a follow-up `GET` of the
 * service (`spriteServiceGet`'s own logic), which throws if its `state.status`
 * is `"failed"`. `spriteServiceStart` follows the same create-then-GET shape
 * (`PUT` already started it; `start` is for a stopped service).
 */

import { resolveSpritesEndpoint, defaultSpritesHttp, type SpritesHttp } from "./sprites";

// ── URL building (pure) ─────────────────────────────────────────────────────

const servicesUrl = (base: string, id: string): string => `${base}/v1/sprites/${encodeURIComponent(id)}/services`;
const serviceUrl = (base: string, id: string, name: string): string =>
  `${servicesUrl(base, id)}/${encodeURIComponent(name)}`;
const serviceLogsUrl = (base: string, id: string, name: string): string => `${serviceUrl(base, id, name)}/logs`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Shapes (wisp's guest API shapes, per spritzer's services.go) ───────────

/** A service's live half. */
export interface SpriteServiceState {
  name: string;
  /** `stopped` | `running` | `stopping` | `failed`. */
  status: string;
  pid?: number;
  started_at?: string;
  error?: string;
  restart_count?: number;
}

/** The `GET`/`PUT` response shape: the definition with its state beside it. */
export interface SpriteService {
  name: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
  /** Names of services that must be running first. */
  needs?: string[];
  /** Route the sprite's public URL to this port. Only one service may set it. */
  http_port?: number;
  state: SpriteServiceState;
}

export interface SpriteServiceCreateArgs {
  /** Target sprite id. */
  id: string;
  /** Service name — the key every later call addresses it by. */
  name: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
  needs?: string[];
  http_port?: number;
  /**
   * How long spritzer keeps streaming NDJSON after the start action
   * succeeds, ms (`?duration`). Default: `500`. A crash past this window is
   * caught by a later `spriteServiceGet`/`spriteUrl`, not this call.
   */
  durationMs?: number;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceGetArgs {
  id: string;
  name: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceListArgs {
  id: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceStartArgs {
  id: string;
  name: string;
  /** Same as `spriteServiceCreate`'s `durationMs`. Default: `500`. */
  durationMs?: number;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceStopArgs {
  id: string;
  name: string;
  /** Grace period before SIGKILL, ms (`?timeout`). Default: spritzer's own (10s). */
  timeoutMs?: number;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceDeleteArgs {
  id: string;
  name: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceLogsArgs {
  id: string;
  name: string;
  /** Tail length. Default: spritzer's own (100). */
  lines?: number;
  endpoint?: string;
  token?: string;
}

export interface SpriteServiceLogsResult {
  /** The tail, one entry per log line, oldest first. */
  lines: string[];
}

/** Build the `PUT` create-or-update body. Pure. */
export function spriteServiceCreateBody(args: SpriteServiceCreateArgs): Record<string, unknown> {
  return {
    cmd: args.cmd,
    ...(args.args !== undefined ? { args: args.args } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
    ...(args.dir !== undefined ? { dir: args.dir } : {}),
    ...(args.needs !== undefined ? { needs: args.needs } : {}),
    ...(args.http_port !== undefined ? { http_port: args.http_port } : {}),
  };
}

/**
 * Parse a service log NDJSON body (`{type, data, timestamp, ...}` per line,
 * terminated by a `complete` event) into a plain line tail — the `data` text
 * of every non-`complete` event, in stream order. Pure.
 */
export function parseServiceLogNdjson(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const obj = safeJson(t) as { type?: string; data?: string } | undefined;
    if (!obj || obj.type === "complete") continue;
    if (typeof obj.data === "string") lines.push(obj.data);
  }
  return lines;
}

// ── Activities ───────────────────────────────────────────────────────────────

/**
 * Create (or replace) and start a service. `PUT /v1/sprites/{id}/services/{name}`,
 * streamed as NDJSON for `?duration` (mapped from `durationMs`). The stream is
 * read to completion, then a `GET` fetches the definitive state; a `"failed"`
 * status throws with the agent's own error text.
 */
export async function spriteServiceCreate(
  args: SpriteServiceCreateArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteService> {
  const base = resolveSpritesEndpoint(args);
  const durationMs = args.durationMs ?? 500;
  const url = `${serviceUrl(base, args.id, args.name)}?duration=${durationMs}ms`;
  const res = await http("PUT", url, spriteServiceCreateBody(args), undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} service ${args.name} create failed (${res.status}): ${res.text}`);
  }
  const svc = await spriteServiceGet({ id: args.id, name: args.name, endpoint: args.endpoint, token: args.token }, signal, http);
  if (svc.state.status === "failed") {
    throw new Error(`sprite ${args.id} service ${args.name} failed to start: ${svc.state.error ?? "unknown error"}`);
  }
  console.log(`service: sprite/${args.id}/${args.name} ${svc.state.status} (${base})`);
  return svc;
}

/** Get one service. `GET /v1/sprites/{id}/services/{name}`. */
export async function spriteServiceGet(
  args: SpriteServiceGetArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteService> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("GET", serviceUrl(base, args.id, args.name), undefined, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} service ${args.name} get failed (${res.status}): ${res.text}`);
  }
  return (safeJson(res.text) as SpriteService | undefined) ?? ({ name: args.name, cmd: "", state: { name: args.name, status: "stopped" } } as SpriteService);
}

/** List every service on the sprite. `GET /v1/sprites/{id}/services`. */
export async function spriteServiceList(
  args: SpriteServiceListArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteService[]> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("GET", servicesUrl(base, args.id), undefined, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} service list failed (${res.status}): ${res.text}`);
  const parsed = safeJson(res.text);
  return Array.isArray(parsed) ? (parsed as SpriteService[]) : [];
}

/**
 * Start a stopped service. `POST /v1/sprites/{id}/services/{name}/start`,
 * streamed as NDJSON for `?duration`, then a `GET` for the definitive state
 * (same shape as `spriteServiceCreate`).
 */
export async function spriteServiceStart(
  args: SpriteServiceStartArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteService> {
  const base = resolveSpritesEndpoint(args);
  const durationMs = args.durationMs ?? 500;
  const url = `${serviceUrl(base, args.id, args.name)}/start?duration=${durationMs}ms`;
  const res = await http("POST", url, undefined, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} service ${args.name} start failed (${res.status}): ${res.text}`);
  }
  const svc = await spriteServiceGet({ id: args.id, name: args.name, endpoint: args.endpoint, token: args.token }, signal, http);
  if (svc.state.status === "failed") {
    throw new Error(`sprite ${args.id} service ${args.name} failed to start: ${svc.state.error ?? "unknown error"}`);
  }
  console.log(`service: sprite/${args.id}/${args.name} ${svc.state.status} (${base})`);
  return svc;
}

/**
 * Stop a running service (SIGTERM, then SIGKILL after the grace period).
 * `POST /v1/sprites/{id}/services/{name}/stop`.
 */
export async function spriteServiceStop(
  args: SpriteServiceStopArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteService> {
  const base = resolveSpritesEndpoint(args);
  const qs = args.timeoutMs !== undefined ? `?timeout=${args.timeoutMs}ms` : "";
  const url = `${serviceUrl(base, args.id, args.name)}/stop${qs}`;
  const res = await http("POST", url, undefined, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} service ${args.name} stop failed (${res.status}): ${res.text}`);
  }
  const svc = await spriteServiceGet({ id: args.id, name: args.name, endpoint: args.endpoint, token: args.token }, signal, http);
  console.log(`service: sprite/${args.id}/${args.name} ${svc.state.status} (${base})`);
  return svc;
}

/**
 * Delete a service, stopping it first (idempotent; a 404 means it is already
 * gone). `DELETE /v1/sprites/{id}/services/{name}`.
 */
export async function spriteServiceDelete(
  args: SpriteServiceDeleteArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("DELETE", serviceUrl(base, args.id, args.name), undefined, undefined, signal);
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`sprite ${args.id} service ${args.name} delete failed (${res.status}): ${res.text}`);
  }
  console.log(`deleted: sprite/${args.id}/${args.name}`);
  return {};
}

/**
 * Read a service's log tail. `GET /v1/sprites/{id}/services/{name}/logs`,
 * parsed from NDJSON to a plain line array (`parseServiceLogNdjson`).
 */
export async function spriteServiceLogs(
  args: SpriteServiceLogsArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteServiceLogsResult> {
  const base = resolveSpritesEndpoint(args);
  const qs = args.lines !== undefined ? `?lines=${args.lines}` : "";
  const res = await http("GET", `${serviceLogsUrl(base, args.id, args.name)}${qs}`, undefined, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} service ${args.name} logs failed (${res.status}): ${res.text}`);
  }
  return { lines: parseServiceLogNdjson(res.text) };
}
