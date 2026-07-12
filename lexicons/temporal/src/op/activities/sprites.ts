/**
 * Sprites lifecycle activities (#762, #766) — imperative, checkpointable sandbox
 * primitives ([sprites.dev](https://sprites.dev)) as chant Op activities, wired
 * to the faithful Sprites API.
 *
 * Unlike a resource lexicon, Sprites have no desired state to reconcile: they
 * are runtime-orchestration primitives (the same category as `k3dUp` /
 * `httpCheck`). Most activities are a direct call over an injectable HTTP client
 * (`SpritesHttp`); `spriteExec` is the exception — it speaks the control
 * WebSocket exec protocol (non-PTY stream framing, per superfly/sprites-go), so
 * it opens a `ws` connection instead. Exported pure helpers (endpoint
 * resolution, the exec frame accumulator, NDJSON parsers, the comment picker)
 * keep the logic unit-testable without a socket or an HTTP server.
 *
 * The headline capability is checkpoint-as-compensation (S5): an Op checkpoints
 * before a risky phase and, on failure, `spriteRestore`s the labeled checkpoint
 * instead of unwinding with an inverse action — the environment itself is the
 * transaction.
 *
 * S3: endpoint override via `SPRITES_BASE_URL` (an explicit `endpoint` arg wins,
 * then the env, then the real Sprites base), so the same Op targets real Sprites
 * or the in-process fake with no code change.
 */

import WebSocket from "ws";

export const DEFAULT_SPRITES_BASE_URL = "https://api.sprites.dev";

// ── Pure helpers (unit-testable without http/ws) ──────────────────────────────

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

const spritesUrl = (base: string): string => `${base}/v1/sprites`;
const spriteUrl = (base: string, id: string): string => `${spritesUrl(base)}/${encodeURIComponent(id)}`;
// Create uses REST JSON; exec is the control WebSocket below; checkpoints are NDJSON.
const spriteCheckpointUrl = (base: string, id: string): string => `${spriteUrl(base, id)}/checkpoint`;
const spriteCheckpointsUrl = (base: string, id: string): string => `${spriteUrl(base, id)}/checkpoints`;
const spriteCheckpointRestoreUrl = (base: string, id: string, cp: string): string =>
  `${spriteCheckpointsUrl(base, id)}/${encodeURIComponent(cp)}/restore`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Exec stream framing (non-PTY control WebSocket) ────────────────────────────
//
// Every WebSocket message is a binary frame `[StreamID:1 byte][payload]`. The
// client with no stdin sends a single `[4]` (StreamStdinEOF); the server writes
// stdout as `[1]<bytes>`, stderr as `[2]<bytes>`, then `[3]<exitcodebyte>` and
// closes. See superfly/sprites-go websocket.go/exec.go.
export const STREAM_STDIN = 0;
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;
export const STREAM_EXIT = 3;
export const STREAM_STDIN_EOF = 4;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => toBytes(d) as Buffer));
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(0);
}

/**
 * Accumulate a stream of exec frames into `{ stdout, stderr, exitCode }`. Pure
 * and socket-free so the framing is unit-testable: feed `[1]"hi\n"`, `[3]\x00`
 * and get `{ stdout: "hi\n", exitCode: 0 }`. Per-stream payloads are collected
 * as bytes and decoded once, so a multi-byte character split across frames is
 * preserved. The exit code is the first byte of the `[3]` frame (0 when absent).
 */
export function accumulateExecFrames(frames: Iterable<Uint8Array>): SpriteExecResult {
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  let exitCode = 0;
  for (const frame of frames) {
    if (!frame || frame.length === 0) continue;
    const stream = frame[0];
    const payload = frame.subarray(1);
    if (stream === STREAM_STDOUT) outChunks.push(payload);
    else if (stream === STREAM_STDERR) errChunks.push(payload);
    else if (stream === STREAM_EXIT) exitCode = payload.length > 0 ? payload[0] : 0;
  }
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(concat(outChunks)),
    stderr: dec.decode(concat(errChunks)),
    exitCode,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

/**
 * Tokenize a command string into an argv, respecting single/double quotes so
 * `sh -c "exit 7"` becomes `["sh", "-c", "exit 7"]`. Each element is sent as a
 * `cmd` query param; `path` is `argv[0]`. Pure.
 */
export function splitCommand(cmd: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let has = false;
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      has = true;
    } else if (ch === '"') {
      inDouble = true;
      has = true;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      if (has) {
        argv.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) argv.push(cur);
  return argv;
}

/**
 * Build the `wss://.../exec?cmd=...&path=...&stdin=false&cc=true` URL for a
 * command (http→ws, https→wss). Pure.
 */
export function spriteExecWsUrl(base: string, id: string, cmd: string): string {
  const wsBase = base.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
  const argv = splitCommand(cmd);
  const params = new URLSearchParams();
  for (const a of argv) params.append("cmd", a);
  params.set("path", argv[0] ?? "");
  params.set("stdin", "false");
  params.set("cc", "true");
  return `${wsBase}/v1/sprites/${encodeURIComponent(id)}/exec?${params.toString()}`;
}

// ── Checkpoint NDJSON + comment picker ─────────────────────────────────────────

/**
 * Parse a checkpoint create/restore NDJSON body (line-delimited JSON progress
 * events) and capture the `complete` event's `id`. Pure. Blank/unparseable
 * lines are skipped; `checkpointId` is "" when no completion event is present.
 */
export function parseCheckpointNdjson(text: string): SpriteCheckpointResult {
  let checkpointId = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const obj = safeJson(t) as { event?: string; id?: string } | undefined;
    if (obj && obj.event === "complete" && typeof obj.id === "string") checkpointId = obj.id;
  }
  return { checkpointId };
}

/**
 * Pick the newest checkpoint whose `comment` matches, so a comment-tagged
 * restore rewinds to the most recent labeled snapshot. Newest is by
 * `create_time`; array order breaks ties (the list is chronological). Pure.
 */
export function pickCheckpointByComment(list: Checkpoint[], comment: string): Checkpoint | undefined {
  return newestOf(list.filter((c) => c.comment === comment));
}

function newestOf(list: Checkpoint[]): Checkpoint | undefined {
  let best: Checkpoint | undefined;
  for (const c of list) {
    if (!best || compareCreateTime(c, best) >= 0) best = c;
  }
  return best;
}

function compareCreateTime(a: Checkpoint, b: Checkpoint): number {
  const ta = Date.parse(a.create_time);
  const tb = Date.parse(b.create_time);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return ta - tb;
}

// ── Activity contracts (the stable interface the Ops/emulator target) ──────────

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
  /** Command to run inside the sprite (tokenized into argv, quotes respected). */
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
  /** Caller-chosen checkpoint comment (S4); a comment-tagged `spriteRestore` matches it. */
  comment?: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteCheckpointResult {
  /** The server checkpoint version (e.g. `v3`) captured from the `complete` event. */
  checkpointId: string;
}

export interface Checkpoint {
  id: string;
  comment: string;
  create_time: string;
  is_auto: boolean;
}

export interface SpriteRestoreArgs {
  id: string;
  /** Explicit checkpoint id (e.g. `v3`); wins over `comment`. */
  checkpoint?: string;
  /** Restore the newest checkpoint carrying this comment. */
  comment?: string;
  endpoint?: string;
  token?: string;
}

export interface ListCheckpointsArgs {
  id: string;
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

// ── HTTP ───────────────────────────────────────────────────────────────────────

/**
 * Injectable HTTP client — mirrors fly's `FlyHttp`. Tests inject a fake; the
 * default hits `fetch`. Used by create/destroy/checkpoint/list/restore; exec
 * goes over the control WebSocket instead.
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
 * Run a command in the sprite over the control WebSocket (non-PTY stream
 * framing, per superfly/sprites-go). Connects to `wss://.../exec`, sends a
 * single `[4]` (stdin EOF), accumulates stdout/stderr frames, and reads the
 * exit code from the `[3]` frame. A non-zero exit is a failed activity (it
 * throws) so a risky step fails its phase and triggers `onFailure`
 * compensation (S5).
 */
export async function spriteExec(args: SpriteExecArgs, signal?: AbortSignal): Promise<SpriteExecResult> {
  const base = resolveSpritesEndpoint(args);
  const url = spriteExecWsUrl(base, args.id, args.cmd);
  const token = args.token ?? process.env.SPRITES_API_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const result = await new Promise<SpriteExecResult>((resolve, reject) => {
    const frames: Uint8Array[] = [];
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      finish(() => reject(new Error(`sprite ${args.id} exec aborted`)));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }
    ws.on("open", () => {
      // No stdin: signal EOF immediately (belt and braces with stdin=false).
      ws.send(Uint8Array.of(STREAM_STDIN_EOF));
    });
    ws.on("message", (data) => {
      const bytes = toBytes(data);
      frames.push(bytes);
      if (bytes.length > 0 && bytes[0] === STREAM_EXIT) {
        try {
          ws.close();
        } catch {
          /* closing already */
        }
      }
    });
    ws.on("error", (err) => finish(() => reject(err)));
    ws.on("close", () => finish(() => resolve(accumulateExecFrames(frames))));
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `sprite ${args.id} exec "${args.cmd}" exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/**
 * Checkpoint the sprite. `POST /v1/sprites/{id}/checkpoint` (singular); the
 * `comment` key is omitted when empty. The response is an NDJSON progress
 * stream; the created version id comes from the `complete` event.
 */
export async function spriteCheckpoint(
  args: SpriteCheckpointArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteCheckpointResult> {
  const base = resolveSpritesEndpoint(args);
  const body = args.comment ? { comment: args.comment } : undefined;
  const res = await http("POST", spriteCheckpointUrl(base, args.id), body, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} checkpoint failed (${res.status}): ${res.text}`);
  const result = parseCheckpointNdjson(res.text);
  console.log(`checkpoint: sprite/${args.id} @${result.checkpointId} (${base})`);
  return result;
}

/**
 * List a sprite's checkpoints. `GET /v1/sprites/{id}/checkpoints` → a bare array
 * `[{ id, comment, create_time, is_auto }]` (auto checkpoints excluded by
 * default on the server).
 */
export async function listCheckpoints(
  args: ListCheckpointsArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Checkpoint[]> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("GET", spriteCheckpointsUrl(base, args.id), undefined, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} list checkpoints failed (${res.status}): ${res.text}`);
  const parsed = safeJson(res.text);
  return Array.isArray(parsed) ? (parsed as Checkpoint[]) : [];
}

/**
 * Restore the sprite to a checkpoint (S5, the compensation path). Resolution
 * order: an explicit `checkpoint` id wins; otherwise the newest checkpoint
 * carrying `comment`; otherwise the newest checkpoint overall. Restore is
 * `POST /v1/sprites/{id}/checkpoints/{cp}/restore` and returns an NDJSON stream.
 */
export async function spriteRestore(
  args: SpriteRestoreArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  let target = args.checkpoint;
  if (!target) {
    const list = await listCheckpoints({ ...args }, signal, http);
    const picked =
      args.comment !== undefined ? pickCheckpointByComment(list, args.comment) : newestOf(list);
    if (!picked) {
      const which = args.comment !== undefined ? `comment "${args.comment}"` : "any checkpoint";
      throw new Error(`sprite ${args.id} restore: no checkpoint matching ${which}`);
    }
    target = picked.id;
  }
  const res = await http("POST", spriteCheckpointRestoreUrl(base, args.id, target), undefined, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} restore to "${target}" failed (${res.status}): ${res.text}`);
  }
  console.log(`restored: sprite/${args.id} to ${target} (${base})`);
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
