/**
 * Sprite filesystem activities (#848) — imperative file-I/O primitives over the
 * Sprites filesystem API (`/v1/sprites/{id}/fs/*`). Same category as the
 * lifecycle activities in `sprites.ts`: runtime-orchestration primitives, no
 * desired state. They let an Op stage an input file into a sprite and read a
 * result out without shelling it through `spriteExec` + `cat`/`tee`.
 *
 * read/write move raw file bytes in the body (not JSON), so these use a small
 * raw HTTP client (`SpritesRawHttp`) rather than the JSON `SpritesHttp` the
 * lifecycle activities use; path/mode/mkdir/recursive ride as query params.
 * Endpoint + bearer resolution mirror `sprites.ts` — an explicit `endpoint` /
 * `token` wins, then `SPRITES_BASE_URL` / `SPRITES_API_TOKEN`.
 */

import { resolveSpritesEndpoint } from "./sprites";

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Pure URL builders (unit-testable) ──────────────────────────────────────────

/**
 * Build a `/v1/sprites/{id}/fs/{op}?...` URL. `params` values that are undefined
 * or empty are dropped so the query only carries what the caller set. Pure.
 */
export function spriteFsUrl(
  base: string,
  id: string,
  op: "read" | "write" | "list" | "delete",
  params: Record<string, string | boolean | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    q.set(k, typeof v === "boolean" ? String(v) : v);
  }
  const qs = q.toString();
  return `${base}/v1/sprites/${encodeURIComponent(id)}/fs/${op}${qs ? `?${qs}` : ""}`;
}

// ── Raw HTTP client (raw string bodies, mirrors defaultSpritesHttp) ─────────────

/**
 * Injectable raw HTTP client — like `SpritesHttp` but the body is sent verbatim
 * (a file's bytes as a string), not JSON-encoded, and the response `text` is the
 * raw body. Tests inject a fake; the default hits `fetch`.
 */
export type SpritesRawHttp = (
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

/**
 * Default `fetch`-based raw client. Sends the body as-is with an
 * `application/octet-stream` content-type and `Authorization: Bearer <token>`
 * when a token is set (real Sprites); the fake ignores the token. The token
 * defaults to `SPRITES_API_TOKEN` at call time. `fetchImpl` is injectable.
 */
export function defaultSpritesRawHttp(token?: string, fetchImpl: typeof fetch = fetch): SpritesRawHttp {
  return async (method, url, body, headers, signal) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/octet-stream";
    const tok = token ?? process.env.SPRITES_API_TOKEN;
    if (tok) h["authorization"] = `Bearer ${tok}`;
    const res = await fetchImpl(url, {
      method,
      headers: Object.keys(h).length ? h : undefined,
      body,
      signal,
    });
    return { status: res.status, text: await res.text() };
  };
}

// ── Activity contracts ──────────────────────────────────────────────────────────

export interface SpriteWriteFileArgs {
  /** Target sprite id (the `name` passed to `spriteCreate`). */
  id: string;
  /** Absolute path (or relative to `workingDir`) to write. */
  path: string;
  /** File contents. */
  content: string;
  /** Octal file mode, e.g. `"0644"`. */
  mode?: string;
  /** Create missing parent directories. */
  mkdir?: boolean;
  /** Base directory for a relative `path`. */
  workingDir?: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteReadFileArgs {
  id: string;
  path: string;
  workingDir?: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteReadFileResult {
  content: string;
}

export interface SpriteListDirArgs {
  id: string;
  path: string;
  workingDir?: string;
  endpoint?: string;
  token?: string;
}

/** One directory entry. `type` is `file` or `dir`. */
export interface SpriteDirEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface SpriteRemoveArgs {
  id: string;
  path: string;
  /** Remove a directory and its contents. */
  recursive?: boolean;
  /** Perform the delete as root. */
  asRoot?: boolean;
  workingDir?: string;
  endpoint?: string;
  token?: string;
}

// ── Activities (ActivityFn: (args, signal?) => Promise<unknown>) ──────────────

/** Write a file into the sprite. `PUT /v1/sprites/{id}/fs/write` with raw body. */
export async function spriteWriteFile(
  args: SpriteWriteFileArgs,
  signal?: AbortSignal,
  http: SpritesRawHttp = defaultSpritesRawHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const url = spriteFsUrl(base, args.id, "write", {
    path: args.path,
    mode: args.mode,
    mkdir: args.mkdir,
    workingDir: args.workingDir,
  });
  const res = await http("PUT", url, args.content, undefined, signal);
  if (res.status >= 300) {
    throw new Error(`sprite ${args.id} write ${args.path} failed (${res.status}): ${res.text}`);
  }
  console.log(`wrote: sprite/${args.id}:${args.path} (${args.content.length}b)`);
  return {};
}

/** Read a file from the sprite. `GET /v1/sprites/{id}/fs/read` → raw body. */
export async function spriteReadFile(
  args: SpriteReadFileArgs,
  signal?: AbortSignal,
  http: SpritesRawHttp = defaultSpritesRawHttp(args.token),
): Promise<SpriteReadFileResult> {
  const base = resolveSpritesEndpoint(args);
  const url = spriteFsUrl(base, args.id, "read", { path: args.path, workingDir: args.workingDir });
  const res = await http("GET", url, undefined, undefined, signal);
  if (res.status === 404) throw new Error(`sprite ${args.id} read ${args.path}: not found`);
  if (res.status >= 300) throw new Error(`sprite ${args.id} read ${args.path} failed (${res.status}): ${res.text}`);
  return { content: res.text };
}

/** List a directory in the sprite. `GET /v1/sprites/{id}/fs/list` → entry array. */
export async function spriteListDir(
  args: SpriteListDirArgs,
  signal?: AbortSignal,
  http: SpritesRawHttp = defaultSpritesRawHttp(args.token),
): Promise<SpriteDirEntry[]> {
  const base = resolveSpritesEndpoint(args);
  const url = spriteFsUrl(base, args.id, "list", { path: args.path, workingDir: args.workingDir });
  const res = await http("GET", url, undefined, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} list ${args.path} failed (${res.status}): ${res.text}`);
  const parsed = safeJson(res.text);
  // Accept a bare array or a `{ entries: [...] }` envelope.
  if (Array.isArray(parsed)) return parsed as SpriteDirEntry[];
  const entries = (parsed as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(entries) ? (entries as SpriteDirEntry[]) : [];
}

/**
 * Remove a path in the sprite. `DELETE /v1/sprites/{id}/fs/delete`. Idempotent:
 * a 404 (already gone) is a no-op, matching `rm -f` and the destroy activity.
 */
export async function spriteRemove(
  args: SpriteRemoveArgs,
  signal?: AbortSignal,
  http: SpritesRawHttp = defaultSpritesRawHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const url = spriteFsUrl(base, args.id, "delete", {
    path: args.path,
    recursive: args.recursive,
    asRoot: args.asRoot,
    workingDir: args.workingDir,
  });
  const res = await http("DELETE", url, undefined, undefined, signal);
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`sprite ${args.id} remove ${args.path} failed (${res.status}): ${res.text}`);
  }
  console.log(`removed: sprite/${args.id}:${args.path}`);
  return {};
}
