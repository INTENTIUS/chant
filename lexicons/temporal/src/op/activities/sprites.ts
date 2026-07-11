/**
 * Sprites lifecycle activities (#762) — imperative, checkpointable sandbox
 * primitives ([sprites.dev](https://sprites.dev)) as chant Op activities.
 *
 * Unlike a resource lexicon, Sprites have no desired state to reconcile: they
 * are runtime-orchestration primitives (the same category as `k3dUp` /
 * `httpCheck`). Each activity is a direct REST call over an injectable HTTP
 * client, mirroring `fly-apply.ts`: exported pure helpers (endpoint resolution,
 * request/response mappers) so the logic is unit-testable without HTTP, and a
 * default `fetch` impl that adds `Authorization: Bearer ${SPRITES_API_TOKEN}`
 * when a token is set.
 *
 * The headline capability is checkpoint-as-compensation (S5): an Op checkpoints
 * before a risky phase and, on failure, `spriteRestore`s the labeled checkpoint
 * instead of unwinding with an inverse action — the environment itself is the
 * transaction.
 *
 * S3: endpoint override via `SPRITES_BASE_URL` (an explicit `endpoint` arg wins,
 * then the env, then the real Sprites base), so the same Op targets real Sprites
 * or the in-process fake with no code change.
 *
 * S6: the REST surface below is provisional — confirm it against the official
 * Sprites API before wiring the real path. The activity input/output contracts
 * (the `Args`/`Result` shapes) are the stable interface the Ops and the emulator
 * are written against; only the endpoint constants may move.
 */

/**
 * TODO(confirm against sprites.dev API): default host + path shapes are
 * provisional (S6). The fake and the activities agree on these; align to the
 * official REST surface once confirmed and keep the activity contracts stable.
 */
export const DEFAULT_SPRITES_BASE_URL = "https://api.sprites.dev";

// ── Pure helpers (unit-testable without http) ─────────────────────────────────

/**
 * Resolve the Sprites base URL (S3): an explicit `endpoint` arg wins, then the
 * `SPRITES_BASE_URL` env, then the real-Sprites default. The trailing slash is
 * stripped so `${base}/v1/...` never doubles up. Pure — mirrors fly's
 * `resolveEndpoint`.
 */
export function resolveSpritesEndpoint(
  args: { endpoint?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = args.endpoint || env.SPRITES_BASE_URL || DEFAULT_SPRITES_BASE_URL;
  return base.replace(/\/$/, "");
}

// TODO(confirm against sprites.dev API): provisional REST paths (S6).
const spritesUrl = (base: string): string => `${base}/v1/sprites`;
const spriteUrl = (base: string, id: string): string => `${spritesUrl(base)}/${encodeURIComponent(id)}`;
const spriteExecUrl = (base: string, id: string): string => `${spriteUrl(base, id)}/exec`;
const spriteCheckpointsUrl = (base: string, id: string): string => `${spriteUrl(base, id)}/checkpoints`;
const spriteRestoreUrl = (base: string, id: string): string => `${spriteUrl(base, id)}/restore`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Activity contracts (S6: the stable interface) ─────────────────────────────

export interface SpriteCreateArgs {
  /** Caller-chosen name, used as the sprite `id` (S4). Every later activity keys on it. */
  name: string;
  /** Base image for the sandbox. */
  image?: string;
  /** Sandbox size (vCPU/memory class). */
  size?: string;
  /** Network / execution policy passed through to the sprite. */
  policy?: unknown;
  /** Endpoint override (S3). Default: `SPRITES_BASE_URL`, else real Sprites. */
  endpoint?: string;
  /** Bearer token. Default: `SPRITES_API_TOKEN`. The fake ignores it. */
  token?: string;
}

export interface SpriteCreateResult {
  id: string;
  url: string;
}

export interface SpriteExecArgs {
  /** Target sprite id (the `name` passed to `spriteCreate`). */
  id: string;
  /** Command to run inside the sprite. */
  cmd: string;
  /** Per-exec timeout in ms. */
  timeoutMs?: number;
  endpoint?: string;
  token?: string;
}

export interface SpriteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpriteCheckpointArgs {
  id: string;
  /** Caller-chosen checkpoint label (S4); `spriteRestore` references the same one. */
  label?: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteCheckpointResult {
  checkpointId: string;
}

export interface SpriteRestoreArgs {
  id: string;
  /** The label passed to a prior `spriteCheckpoint`. */
  checkpoint: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteDestroyArgs {
  id: string;
  endpoint?: string;
  token?: string;
}

/** Build the `POST /v1/sprites` body. Pure. */
export function spriteCreateBody(args: SpriteCreateArgs): Record<string, unknown> {
  return {
    name: args.name,
    ...(args.image !== undefined ? { image: args.image } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    ...(args.policy !== undefined ? { policy: args.policy } : {}),
  };
}

/** Parse the create response; the caller-chosen `name` is the id fallback (S4). Pure. */
export function parseCreateResponse(text: string, name: string): SpriteCreateResult {
  const b = safeJson(text) as { id?: string; url?: string } | undefined;
  return { id: b?.id ?? name, url: b?.url ?? "" };
}

/** Build the `POST /v1/sprites/{id}/exec` body. Pure. */
export function spriteExecBody(args: SpriteExecArgs): Record<string, unknown> {
  return { cmd: args.cmd, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) };
}

/** Parse an exec response into the stdout/stderr/exitCode contract. Pure. */
export function parseExecResponse(text: string): SpriteExecResult {
  const b = safeJson(text) as Partial<SpriteExecResult> | undefined;
  return {
    stdout: typeof b?.stdout === "string" ? b.stdout : "",
    stderr: typeof b?.stderr === "string" ? b.stderr : "",
    exitCode: typeof b?.exitCode === "number" ? b.exitCode : 0,
  };
}

/** Parse a checkpoint response; the label is the checkpointId fallback (S4). Pure. */
export function parseCheckpointResponse(text: string, label: string): SpriteCheckpointResult {
  const b = safeJson(text) as { checkpointId?: string } | undefined;
  return { checkpointId: b?.checkpointId ?? label };
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

/**
 * Injectable HTTP client — mirrors fly's `FlyHttp`. Tests inject a fake; the
 * default hits `fetch`.
 */
export type SpritesHttp = (
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

/**
 * Default `fetch`-based client. Sends `Authorization: Bearer <token>` when a
 * token is set (real Sprites); the fake ignores it. The token defaults to
 * `SPRITES_API_TOKEN` at call time. `fetchImpl` is injectable for tests.
 */
export function defaultSpritesHttp(token?: string, fetchImpl: typeof fetch = fetch): SpritesHttp {
  return async (method, url, body, headers, signal) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const tok = token ?? process.env.SPRITES_API_TOKEN;
    if (tok) h["authorization"] = `Bearer ${tok}`;
    const res = await fetchImpl(url, {
      method,
      headers: Object.keys(h).length ? h : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return { status: res.status, text: await res.text() };
  };
}

// ── Activities (ActivityFn: (args, signal?) => Promise<unknown>) ──────────────

/** Create a sprite with the caller-chosen `name` as its id (S4). `POST /v1/sprites`. */
export async function spriteCreate(
  args: SpriteCreateArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteCreateResult> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("POST", spritesUrl(base), spriteCreateBody(args), undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.name} create failed (${res.status}): ${res.text}`);
  const result = parseCreateResponse(res.text, args.name);
  console.log(`created: sprite/${result.id} (${base})`);
  return result;
}

/**
 * Run a command in the sprite. `POST /v1/sprites/{id}/exec`. A non-zero exit is
 * a failed activity (it throws) so a risky step fails its phase and triggers
 * `onFailure` compensation (S5).
 */
export async function spriteExec(
  args: SpriteExecArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteExecResult> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("POST", spriteExecUrl(base, args.id), spriteExecBody(args), undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} exec failed (${res.status}): ${res.text}`);
  const result = parseExecResponse(res.text);
  if (result.exitCode !== 0) {
    throw new Error(`sprite ${args.id} exec "${args.cmd}" exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  return result;
}

/** Checkpoint the sprite under a caller-chosen label (S4). `POST /v1/sprites/{id}/checkpoints`. */
export async function spriteCheckpoint(
  args: SpriteCheckpointArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteCheckpointResult> {
  const base = resolveSpritesEndpoint(args);
  const label = args.label ?? "checkpoint";
  const body = { ...(args.label !== undefined ? { label: args.label } : {}) };
  const res = await http("POST", spriteCheckpointsUrl(base, args.id), body, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} checkpoint failed (${res.status}): ${res.text}`);
  const result = parseCheckpointResponse(res.text, label);
  console.log(`checkpoint: sprite/${args.id} @${result.checkpointId} (${base})`);
  return result;
}

/**
 * Restore the sprite to a labeled checkpoint (S5, the compensation path).
 * `POST /v1/sprites/{id}/restore`.
 */
export async function spriteRestore(
  args: SpriteRestoreArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("POST", spriteRestoreUrl(base, args.id), { checkpoint: args.checkpoint }, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} restore to "${args.checkpoint}" failed (${res.status}): ${res.text}`);
  console.log(`restored: sprite/${args.id} → ${args.checkpoint} (${base})`);
  return {};
}

/** Destroy the sprite (idempotent; a 404 means it is already gone). `DELETE /v1/sprites/{id}`. */
export async function spriteDestroy(
  args: SpriteDestroyArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("DELETE", spriteUrl(base, args.id), undefined, undefined, signal);
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`sprite ${args.id} destroy failed (${res.status}): ${res.text}`);
  }
  console.log(`destroyed: sprite/${args.id} (${base})`);
  return {};
}
