/**
 * Sprite keep-alive Tasks activities (#847) — a hold that prevents a Sprite from
 * pausing while a session runs. While at least one task exists the Sprite stays
 * active; the hold is refreshed on an interval and released on exit.
 *
 * Per the Sprites docs a task carries an `expire` (seconds or a duration string
 * like `"5m"`/`"1h"`) with a **1-hour max per task**, so a session longer than
 * that must refresh. The recommended shape is a short expiry refreshed on a
 * shorter interval — 5-minute expiry / 60-second refresh — released on exit.
 *
 * These are the three primitives, not a magic looping hold: a phased Op creates
 * the task around a session (`spriteTaskCreate`) and releases it after (in the
 * happy path and in `onFailure`). A worker whose session can outlast the 1-hour
 * cap wraps its own run in a `spriteTaskRefresh` loop (that ambient loop lives in
 * the long-running caller, not a single serializable activity — a phased Op has
 * no single step to hang it on). `spriteTaskRelease` is idempotent so a crash
 * still frees the Sprite (and the task auto-expires if the release never lands).
 *
 * The task REST path is provisional (S6, #766); it mirrors the other endpoints'
 * `/v1/sprites/{id}/...` shape. URL building is a pure helper so the path can
 * move without touching callers.
 */

import { resolveSpritesEndpoint, defaultSpritesHttp, type SpritesHttp } from "./sprites";

/** The task REST base for a sprite. Pure. */
export function spriteTasksUrl(base: string, id: string): string {
  return `${base}/v1/sprites/${encodeURIComponent(id)}/tasks`;
}
export function spriteTaskUrl(base: string, id: string, name: string): string {
  return `${spriteTasksUrl(base, id)}/${encodeURIComponent(name)}`;
}

export interface SpriteTaskCreateArgs {
  id: string;
  /** Task name (the key later refresh/release use). */
  name: string;
  /** Expiry: seconds (number) or a duration string (`"5m"`, `"1h"`). Max 1h. */
  expire?: number | string;
  endpoint?: string;
  token?: string;
}

export interface SpriteTaskRefreshArgs extends SpriteTaskCreateArgs {}

export interface SpriteTaskReleaseArgs {
  id: string;
  name: string;
  endpoint?: string;
  token?: string;
}

/** Create a keep-alive task. `POST /v1/sprites/{id}/tasks`. */
export async function spriteTaskCreate(
  args: SpriteTaskCreateArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<{ name: string }> {
  const base = resolveSpritesEndpoint(args);
  const body = { name: args.name, ...(args.expire !== undefined ? { expire: args.expire } : {}) };
  const res = await http("POST", spriteTasksUrl(base, args.id), body, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} task create failed (${res.status}): ${res.text}`);
  return { name: args.name };
}

/** Refresh a task's expiry. `PUT /v1/sprites/{id}/tasks/{name}`. */
export async function spriteTaskRefresh(
  args: SpriteTaskRefreshArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<{ name: string }> {
  const base = resolveSpritesEndpoint(args);
  const body = args.expire !== undefined ? { expire: args.expire } : undefined;
  const res = await http("PUT", spriteTaskUrl(base, args.id, args.name), body, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} task refresh failed (${res.status}): ${res.text}`);
  return { name: args.name };
}

/** Release a task (idempotent; a 404 means already gone). `DELETE /v1/sprites/{id}/tasks/{name}`. */
export async function spriteTaskRelease(
  args: SpriteTaskReleaseArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<Record<string, never>> {
  const base = resolveSpritesEndpoint(args);
  const res = await http("DELETE", spriteTaskUrl(base, args.id, args.name), undefined, undefined, signal);
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`sprite ${args.id} task release failed (${res.status}): ${res.text}`);
  }
  return {};
}
