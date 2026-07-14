/**
 * Hand-authored Fly Sprites API contract (#808 T3).
 *
 * The Fly Machines API ships a machine-readable OpenAPI (docs.machines.dev) that
 * the fly resource surface generates + drift-checks against. The Sprites API
 * (api.sprites.dev) ships no such spec at any conventional path, so there is
 * nothing to diff automatically. This module is the manual stand-in: the exact
 * endpoint set the fly sprite activities (lifecycle, filesystem, config, tasks)
 * depend on, maintained by hand from https://docs.sprites.dev.
 *
 * It anchors two fidelity checks:
 *   1. Coverage — every endpoint here must be served by the pinned spritzer
 *      emulator (its `/_spritzer/health` enumerates implemented paths). If an
 *      activity ever calls something spritzer doesn't model, the docker-gated
 *      contract test fails instead of silently passing against a partial fake.
 *   2. Drift anchor — when the Sprites API changes, a human updates this file;
 *      reviewers see exactly which activity/endpoint moved.
 *
 * Path params are written with names matching ./sprites.ts (`{id}`, `{cp}`);
 * the coverage check normalizes param names before comparing, since spritzer
 * spells the checkpoint id `{cid}`.
 */

/** One endpoint the fly sprite activities call. */
export interface SpritesEndpoint {
  /** HTTP method, or "WS" for the control-WebSocket exec channel. */
  method: "GET" | "POST" | "PUT" | "DELETE" | "WS";
  /** Path template under the Sprites base, e.g. `/v1/sprites/{id}/checkpoint`. */
  path: string;
  /** The fly activity that calls it (an activity module export). */
  activity: string;
}

/**
 * The Sprites endpoints the fly sprite activities depend on, across the lifecycle
 * (./sprites.ts), filesystem (./sprite-fs.ts), config reconcile
 * (./sprite-config.ts), and keep-alive tasks (./sprite-tasks.ts) modules. Keep in
 * sync with the activity implementations — the unit test asserts every sprite
 * activity is represented, and the coverage test asserts the pinned spritzer
 * serves each one.
 */
export const SPRITES_CONTRACT: readonly SpritesEndpoint[] = [
  // Lifecycle (./sprites.ts)
  { method: "POST", path: "/v1/sprites", activity: "spriteCreate" },
  { method: "WS", path: "/v1/sprites/{id}/exec", activity: "spriteExec" },
  { method: "POST", path: "/v1/sprites/{id}/checkpoint", activity: "spriteCheckpoint" },
  { method: "GET", path: "/v1/sprites/{id}/checkpoints", activity: "listCheckpoints" },
  { method: "POST", path: "/v1/sprites/{id}/checkpoints/{cp}/restore", activity: "spriteRestore" },
  { method: "DELETE", path: "/v1/sprites/{id}", activity: "spriteDestroy" },
  // Filesystem (./sprite-fs.ts)
  { method: "PUT", path: "/v1/sprites/{id}/fs/write", activity: "spriteWriteFile" },
  { method: "GET", path: "/v1/sprites/{id}/fs/read", activity: "spriteReadFile" },
  { method: "GET", path: "/v1/sprites/{id}/fs/list", activity: "spriteListDir" },
  { method: "DELETE", path: "/v1/sprites/{id}/fs/delete", activity: "spriteRemove" },
  // Network policy (./sprite-config.ts)
  { method: "GET", path: "/v1/sprites/{id}/policy/network", activity: "spriteApplyNetworkPolicy" },
  { method: "POST", path: "/v1/sprites/{id}/policy/network", activity: "spriteApplyNetworkPolicy" },
  // Services (./sprite-config.ts)
  { method: "GET", path: "/v1/sprites/{id}/services", activity: "spriteApplyServices" },
  { method: "PUT", path: "/v1/sprites/{id}/services/{svc}", activity: "spriteApplyServices" },
  { method: "POST", path: "/v1/sprites/{id}/services/{svc}/start", activity: "spriteApplyServices" },
  // Keep-alive tasks (./sprite-tasks.ts)
  { method: "POST", path: "/v1/sprites/{id}/tasks", activity: "spriteTaskCreate" },
  { method: "PUT", path: "/v1/sprites/{id}/tasks/{name}", activity: "spriteTaskRefresh" },
  { method: "DELETE", path: "/v1/sprites/{id}/tasks/{name}", activity: "spriteTaskRelease" },
] as const;

/**
 * Normalize a `METHOD path` key for comparison across sources: collapse every
 * `{param}` to `{}` (so `{cp}` and `{cid}` match) and treat the WebSocket exec
 * channel as a `GET` (spritzer registers it as `GET .../exec`).
 */
export function normalizeEndpoint(method: string, path: string): string {
  const m = method === "WS" ? "GET" : method.toUpperCase();
  const p = path.replace(/\{[^}]+\}/g, "{}");
  return `${m} ${p}`;
}

/** The contract as a set of normalized `METHOD path` keys. */
export function contractKeys(): Set<string> {
  return new Set(SPRITES_CONTRACT.map((e) => normalizeEndpoint(e.method, e.path)));
}
