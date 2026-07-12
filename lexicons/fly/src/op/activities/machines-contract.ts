/**
 * Fly Machines (flaps) API contract — the endpoint set the `flyApply` applier
 * (./fly-apply.ts) depends on, and the mudflaps counterpart of the hand-authored
 * Sprites contract (./sprites-contract.ts, #808 T3).
 *
 * Unlike Sprites, Machines *does* ship a machine-readable OpenAPI that the fly
 * resource surface drift-checks against (docs.machines.dev, the rolling-upgrade
 * path #813). This contract serves a different fidelity axis: it pins the exact
 * endpoints flyApply calls so the docker-gated coverage test can prove the pinned
 * mudflaps emulator serves them all. mudflaps carries roadmap endpoints that
 * answer 501 (currently machines/{id}/signal, /exec, /ps) — flyApply must never
 * depend on one; if it ever does, the coverage test fails instead of the applier
 * silently passing against a fake that can't model the call.
 *
 * Param names match ./fly-apply.ts's URL builders (`{app}`, `{id}`); the coverage
 * check normalizes param names before comparing, since mudflaps spells volume
 * ids `{vol}` and cert hostnames `{hostname}`.
 */

/** One flaps endpoint the flyApply applier calls. */
export interface MachinesEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path template under the flaps base, e.g. `/v1/apps/{app}/machines/{id}`. */
  path: string;
  /** The applier operation that calls it. */
  op: string;
}

/**
 * The flaps endpoints ./fly-apply.ts depends on. Keep in sync with the applier —
 * the unit test asserts every path segment appears in fly-apply.ts.
 */
export const MACHINES_CONTRACT: readonly MachinesEndpoint[] = [
  // Apps
  { method: "POST", path: "/v1/apps", op: "createApp" },
  { method: "GET", path: "/v1/apps/{app}", op: "getApp" },
  { method: "DELETE", path: "/v1/apps/{app}", op: "deleteApp" },
  // Machines
  { method: "GET", path: "/v1/apps/{app}/machines", op: "listMachines" },
  { method: "POST", path: "/v1/apps/{app}/machines", op: "createMachine" },
  { method: "POST", path: "/v1/apps/{app}/machines/{id}", op: "updateMachine" },
  { method: "DELETE", path: "/v1/apps/{app}/machines/{id}", op: "destroyMachine" },
  { method: "GET", path: "/v1/apps/{app}/machines/{id}/wait", op: "waitForMachine" },
  // Leases
  { method: "POST", path: "/v1/apps/{app}/machines/{id}/lease", op: "acquireLease" },
  { method: "DELETE", path: "/v1/apps/{app}/machines/{id}/lease", op: "releaseLease" },
  // Volumes
  { method: "GET", path: "/v1/apps/{app}/volumes", op: "listVolumes" },
  { method: "POST", path: "/v1/apps/{app}/volumes", op: "createVolume" },
  { method: "DELETE", path: "/v1/apps/{app}/volumes/{id}", op: "deleteVolume" },
  // IP assignments
  { method: "GET", path: "/v1/apps/{app}/ip_assignments", op: "listIps" },
  { method: "POST", path: "/v1/apps/{app}/ip_assignments", op: "allocateIp" },
  { method: "DELETE", path: "/v1/apps/{app}/ip_assignments/{ip}", op: "releaseIp" },
  // Certificates
  { method: "GET", path: "/v1/apps/{app}/certificates", op: "listCerts" },
  { method: "POST", path: "/v1/apps/{app}/certificates", op: "addCert" },
  { method: "DELETE", path: "/v1/apps/{app}/certificates/{hostname}", op: "deleteCert" },
  // Secrets
  { method: "GET", path: "/v1/apps/{app}/secrets", op: "listSecrets" },
  { method: "POST", path: "/v1/apps/{app}/secrets/{name}", op: "setSecret" },
  { method: "DELETE", path: "/v1/apps/{app}/secrets/{name}", op: "deleteSecret" },
] as const;

/** Normalize a `METHOD path` key: collapse every `{param}` to `{}` so param names match. */
export function normalizeEndpoint(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;
}

/** The contract as a set of normalized `METHOD path` keys. */
export function contractKeys(): Set<string> {
  return new Set(MACHINES_CONTRACT.map((e) => normalizeEndpoint(e.method, e.path)));
}
