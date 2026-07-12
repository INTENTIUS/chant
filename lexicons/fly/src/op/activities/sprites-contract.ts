/**
 * Hand-authored Fly Sprites API contract (#808 T3).
 *
 * The Fly Machines API ships a machine-readable OpenAPI (docs.machines.dev) that
 * the fly resource surface generates + drift-checks against. The Sprites API
 * (api.sprites.dev) ships no such spec at any conventional path, so there is
 * nothing to diff automatically. This module is the manual stand-in: the exact
 * endpoint set the fly sprite activities (./sprites.ts) depend on, maintained by
 * hand from https://docs.sprites.dev.
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
  method: "GET" | "POST" | "DELETE" | "WS";
  /** Path template under the Sprites base, e.g. `/v1/sprites/{id}/checkpoint`. */
  path: string;
  /** The fly activity that calls it (./sprites.ts export). */
  activity: string;
}

/**
 * The Sprites endpoints ./sprites.ts depends on. Keep in sync with the activity
 * implementations — the unit test asserts every sprite activity is represented.
 */
export const SPRITES_CONTRACT: readonly SpritesEndpoint[] = [
  { method: "POST", path: "/v1/sprites", activity: "spriteCreate" },
  { method: "WS", path: "/v1/sprites/{id}/exec", activity: "spriteExec" },
  { method: "POST", path: "/v1/sprites/{id}/checkpoint", activity: "spriteCheckpoint" },
  { method: "GET", path: "/v1/sprites/{id}/checkpoints", activity: "listCheckpoints" },
  { method: "POST", path: "/v1/sprites/{id}/checkpoints/{cp}/restore", activity: "spriteRestore" },
  { method: "DELETE", path: "/v1/sprites/{id}", activity: "spriteDestroy" },
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
