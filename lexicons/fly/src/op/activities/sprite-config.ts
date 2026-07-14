/**
 * Sprite config reconcile activities (#849) — the two pieces of genuine
 * desired-state a Sprite carries: its outbound network policy and its background
 * services. Unlike the sprite itself (an Op primitive with no reconcilable
 * create body), these are set after create and persist across cold boots, so
 * chant reconciles typed config against the live Sprite — the `flyApply`
 * plan→CRUD pattern scoped to one Sprite, not a declarable resource.
 *
 * Both use the JSON `SpritesHttp` client from `sprites.ts`; endpoint + bearer
 * resolution is shared. Validation is pure and runs before any HTTP (invalid
 * rules / a `needs` cycle throw up front), so a bad config fails the step
 * cleanly rather than half-applying.
 *
 * Scope (v1): network policy is a whole-object replace (converges by
 * construction); services reconcile is additive + update (create-or-update each
 * desired service, optionally start). Owned-only prune of stale services is out
 * of scope — the documented Services REST surface exposes no delete.
 */

import { resolveSpritesEndpoint, defaultSpritesHttp, type SpritesHttp } from "./sprites";

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Network policy ──────────────────────────────────────────────────────────────

/** One outbound rule. Ordered — specificity is positional, so order is significant. */
export interface NetworkRule {
  domain: string;
  action: "allow" | "deny";
}

export interface SpriteApplyNetworkPolicyArgs {
  id: string;
  /** The complete desired ruleset (whole-object replace). */
  rules: NetworkRule[];
  endpoint?: string;
  token?: string;
}

export interface SpriteApplyNetworkPolicyResult {
  /** True when the live policy differed and was replaced; false when already converged. */
  changed: boolean;
}

/**
 * Validate a ruleset: every rule needs a non-empty `domain` and an `allow`/`deny`
 * `action`. Pure; throws on the first offender.
 */
export function validateNetworkRules(rules: NetworkRule[]): void {
  rules.forEach((r, i) => {
    if (!r || typeof r.domain !== "string" || r.domain.trim() === "") {
      throw new Error(`network rule ${i}: missing domain`);
    }
    if (r.action !== "allow" && r.action !== "deny") {
      throw new Error(`network rule ${i} (${r.domain}): action must be "allow" or "deny", got ${JSON.stringify(r.action)}`);
    }
  });
}

/** Order-sensitive equality of two rulesets (position is significant). Pure. */
export function networkRulesEqual(a: NetworkRule[], b: NetworkRule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.domain === b[i].domain && r.action === b[i].action);
}

const policyUrl = (base: string, id: string): string =>
  `${base}/v1/sprites/${encodeURIComponent(id)}/policy/network`;

/**
 * Reconcile a Sprite's outbound network policy. GET the live ruleset, and POST
 * the desired set only when it differs (`GET`/`POST /policy/network`). Returns
 * whether a change was applied.
 */
export async function spriteApplyNetworkPolicy(
  args: SpriteApplyNetworkPolicyArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteApplyNetworkPolicyResult> {
  validateNetworkRules(args.rules);
  const base = resolveSpritesEndpoint(args);
  const url = policyUrl(base, args.id);

  const cur = await http("GET", url, undefined, undefined, signal);
  if (cur.status >= 300) throw new Error(`sprite ${args.id} get policy failed (${cur.status}): ${cur.text}`);
  const live = (safeJson(cur.text) as { rules?: NetworkRule[] } | undefined)?.rules ?? [];
  if (networkRulesEqual(live, args.rules)) {
    console.log(`policy: sprite/${args.id} already converged (${args.rules.length} rules)`);
    return { changed: false };
  }

  const res = await http("POST", url, { rules: args.rules }, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} set policy failed (${res.status}): ${res.text}`);
  console.log(`policy: sprite/${args.id} applied ${args.rules.length} rules (${base})`);
  return { changed: true };
}

// ── Services ─────────────────────────────────────────────────────────────────────

/** A desired background service. Keyed by `name`; PUT is create-or-update. */
export interface ServiceSpec {
  name: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
  /** Names of services that must start first. */
  needs?: string[];
  /** Route the Sprite's public URL to this port. */
  http_port?: number;
}

export interface SpriteApplyServicesArgs {
  id: string;
  services: ServiceSpec[];
  /** Start each service after applying (in dependency order). Default: false. */
  start?: boolean;
  endpoint?: string;
  token?: string;
}

export interface SpriteApplyServicesResult {
  /** Names that were created or updated (converged services are skipped). */
  applied: string[];
  /** Names that were started (empty unless `start`). */
  started: string[];
}

/**
 * Validate a service set: names are unique, every `needs` target exists, and the
 * dependency graph is acyclic. Pure; throws on the first violation. Returns the
 * names in a valid start order (dependencies first).
 */
export function validateServices(services: ServiceSpec[]): string[] {
  const byName = new Map<string, ServiceSpec>();
  for (const s of services) {
    if (!s.name) throw new Error("service: missing name");
    if (byName.has(s.name)) throw new Error(`service ${s.name}: duplicate name`);
    byName.set(s.name, s);
  }
  for (const s of services) {
    for (const dep of s.needs ?? []) {
      if (!byName.has(dep)) throw new Error(`service ${s.name}: needs "${dep}" which is not defined`);
    }
  }
  // Topological order via DFS; a back-edge is a cycle.
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, trail: string[]): void => {
    const st = state.get(name);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`service dependency cycle: ${[...trail, name].join(" -> ")}`);
    state.set(name, "visiting");
    for (const dep of byName.get(name)!.needs ?? []) visit(dep, [...trail, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const s of services) visit(s.name, []);
  return order;
}

/** Comparable service config (the fields the reconcile diffs on). Pure. */
export function serviceConfigEqual(a: Partial<ServiceSpec>, b: Partial<ServiceSpec>): boolean {
  const norm = (s: Partial<ServiceSpec>): string =>
    JSON.stringify({
      cmd: s.cmd ?? "",
      args: s.args ?? [],
      env: s.env ?? {},
      dir: s.dir ?? "",
      needs: s.needs ?? [],
      http_port: s.http_port ?? null,
    });
  return norm(a) === norm(b);
}

const servicesUrl = (base: string, id: string): string =>
  `${base}/v1/sprites/${encodeURIComponent(id)}/services`;
const serviceUrl = (base: string, id: string, svc: string): string =>
  `${servicesUrl(base, id)}/${encodeURIComponent(svc)}`;

function serviceBody(s: ServiceSpec): Record<string, unknown> {
  return {
    cmd: s.cmd,
    ...(s.args ? { args: s.args } : {}),
    ...(s.env ? { env: s.env } : {}),
    ...(s.dir ? { dir: s.dir } : {}),
    ...(s.needs ? { needs: s.needs } : {}),
    ...(s.http_port !== undefined ? { http_port: s.http_port } : {}),
  };
}

/**
 * Reconcile a Sprite's background services (additive + update). Lists the live
 * services, then `PUT`s each desired service that is new or changed
 * (create-or-update by name); when `start` is set, `POST .../start`s them in
 * dependency order. Converged services are skipped. Owned-only prune is out of
 * scope (no delete in the Services REST surface).
 */
export async function spriteApplyServices(
  args: SpriteApplyServicesArgs,
  signal?: AbortSignal,
  http: SpritesHttp = defaultSpritesHttp(args.token),
): Promise<SpriteApplyServicesResult> {
  const startOrder = validateServices(args.services);
  const base = resolveSpritesEndpoint(args);
  const byName = new Map(args.services.map((s) => [s.name, s]));

  // Live services, keyed by name, for the create-vs-update diff.
  const listRes = await http("GET", servicesUrl(base, args.id), undefined, undefined, signal);
  if (listRes.status >= 300) throw new Error(`sprite ${args.id} list services failed (${listRes.status}): ${listRes.text}`);
  const liveList = safeJson(listRes.text);
  const live = new Map<string, Partial<ServiceSpec>>();
  if (Array.isArray(liveList)) {
    for (const s of liveList as Array<Partial<ServiceSpec> & { name?: string }>) {
      if (s.name) live.set(s.name, s);
    }
  }

  const applied: string[] = [];
  for (const s of args.services) {
    const cur = live.get(s.name);
    if (cur && serviceConfigEqual(cur, s)) continue; // already converged
    const res = await http("PUT", serviceUrl(base, args.id, s.name), serviceBody(s), undefined, signal);
    if (res.status >= 300) throw new Error(`sprite ${args.id} apply service ${s.name} failed (${res.status}): ${res.text}`);
    applied.push(s.name);
  }
  console.log(`services: sprite/${args.id} applied ${applied.length}/${args.services.length} (${base})`);

  const started: string[] = [];
  if (args.start) {
    for (const name of startOrder) {
      if (!byName.has(name)) continue;
      const res = await http("POST", `${serviceUrl(base, args.id, name)}/start`, undefined, undefined, signal);
      if (res.status >= 300) throw new Error(`sprite ${args.id} start service ${name} failed (${res.status}): ${res.text}`);
      started.push(name);
    }
    console.log(`services: sprite/${args.id} started ${started.length} in dependency order`);
  }

  return { applied, started };
}
