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
 *
 * `spriteApplyServices` with no `id` runs inside the sprite instead (#2880):
 * it applies the box block's services (`box: true`) through `sprite-env
 * services`, which has no update, so a changed service is deleted and created.
 * It deletes nothing the box block does not declare.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serviceCommandArgv, inStartOrder, boxServices, type BoxServiceDeclaration } from "./box-services";
import { findSpriteEnv } from "./sprite-service-converge";
import { resolveSpritesEndpoint, defaultSpritesHttp, type SpritesHttp } from "./sprites";
import { logProgress } from "./progress";

const execFileAsync = promisify(execFile);

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
    logProgress(`policy: sprite/${args.id} already converged (${args.rules.length} rules)`);
    return { changed: false };
  }

  const res = await http("POST", url, { rules: args.rules }, undefined, signal);
  if (res.status >= 300) throw new Error(`sprite ${args.id} set policy failed (${res.status}): ${res.text}`);
  logProgress(`policy: sprite/${args.id} applied ${args.rules.length} rules (${base})`);
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
  /** The sprite, for the Sprites API. Without it, the step runs inside the sprite and applies the box block's services through `sprite-env` (#2880). */
  id?: string;
  /** The services, for the Sprites API. Required with `id`. */
  services?: ServiceSpec[];
  /** Without `id`: apply the services of the box block of the workspace member whose directory holds the working directory (#2880). Required without `id`. */
  box?: boolean;
  /** Without `id`: apply only these declared services, in dependency order. An `optional` service is applied only when named here. */
  only?: string[];
  /**
   * Start services after applying, in dependency order. With `id`, every
   * service; without, every applied one that is not running (a created or
   * replaced one is started by its create). Default: false.
   */
  start?: boolean;
  /** Without `id`: restart each applied service that was already converged. Default: false. */
  restart?: boolean;
  /** Without `id`: the `sprite-env` binary. Default: the one on PATH, else /.sprite/bin/sprite-env. */
  spriteEnv?: string;
  endpoint?: string;
  token?: string;
}

/** What an apply through sprite-env did to one service (#2880). */
export type ServiceApplyAction = "created" | "replaced" | "restarted" | "started" | "left";

export interface SpriteApplyServicesResult {
  /** Names that were created or updated (converged services are skipped). */
  applied: string[];
  /** Names that were started (empty unless `start`). */
  started: string[];
  /**
   * Without `id`: each service applied, in the order it was applied, with
   * what the apply did to it (#2880). `left` is a converged service that was
   * not restarted or started.
   */
  services?: { name: string; action: ServiceApplyAction }[];
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
  http?: SpritesHttp,
): Promise<SpriteApplyServicesResult> {
  if (!args.id) return applyThroughSpriteEnv(args, signal);
  if (args.box || args.only || args.restart) {
    throw new Error("spriteApplyServices: box, only and restart apply a box's services through sprite-env inside the sprite; drop the id to use them");
  }
  if (!args.services) throw new Error("spriteApplyServices: an id needs its services");
  return applyThroughApi({ ...args, id: args.id, services: args.services }, signal, http ?? defaultSpritesHttp(args.token));
}

async function applyThroughApi(
  args: SpriteApplyServicesArgs & { id: string; services: ServiceSpec[] },
  signal: AbortSignal | undefined,
  http: SpritesHttp,
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
  logProgress(`services: sprite/${args.id} applied ${applied.length}/${args.services.length} (${base})`);

  const started: string[] = [];
  if (args.start) {
    for (const name of startOrder) {
      if (!byName.has(name)) continue;
      const res = await http("POST", `${serviceUrl(base, args.id, name)}/start`, undefined, undefined, signal);
      if (res.status >= 300) throw new Error(`sprite ${args.id} start service ${name} failed (${res.status}): ${res.text}`);
      started.push(name);
    }
    logProgress(`services: sprite/${args.id} started ${started.length} in dependency order`);
  }

  return { applied, started };
}

// ── Services through sprite-env (#2880) ─────────────────────────────────────

/** A service as `sprite-env services list` reports it. A field the listing does not carry is undefined. */
export interface ListedService {
  name: string;
  status: string | null;
  cmd?: string;
  needs?: string[];
  httpPort?: number | null;
}

/**
 * `sprite-env services list` with each service's definition. A sprite's
 * sprite-env prints JSON (`[{ name, cmd, args, needs, http_port, state: {
 * status } }]`); the studio kit's stand-in has printed a table of name,
 * state, needs (`-` for none), http port (`-`) and cmd, tab-separated. A
 * table with fewer columns gives the name and state only. Pure.
 */
export function parseServiceDefinitions(text: string): ListedService[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { services?: unknown }).services ?? []);
    const out: ListedService[] = [];
    for (const s of list as Record<string, unknown>[]) {
      if (typeof s?.name !== "string") continue;
      const state = s.state as { status?: unknown } | undefined;
      const status = typeof state?.status === "string" ? state.status : typeof s.status === "string" ? s.status : null;
      const args = Array.isArray(s.args) ? (s.args as unknown[]).map(String) : [];
      out.push({
        name: s.name,
        status,
        ...(typeof s.cmd === "string" ? { cmd: args.length > 0 ? [s.cmd, ...args].join(" ") : s.cmd } : {}),
        ...(Array.isArray(s.needs) ? { needs: (s.needs as unknown[]).map(String) } : s.needs === null ? { needs: [] } : {}),
        ...("http_port" in s ? { httpPort: typeof s.http_port === "number" && s.http_port > 0 ? s.http_port : null } : {}),
      });
    }
    return out;
  }
  const out: ListedService[] = [];
  for (const line of trimmed.split("\n")) {
    const cols = line.split("\t");
    const name = cols[0]?.trim();
    if (!name) continue;
    const listed: ListedService = { name, status: cols[1]?.trim() || null };
    if (cols.length >= 5) {
      const needs = cols[2].trim();
      const port = cols[3].trim();
      listed.needs = needs === "-" || needs === "" ? [] : needs.split(",");
      listed.httpPort = port === "-" || port === "" ? null : Number(port);
      listed.cmd = cols.slice(4).join("\t");
    }
    out.push(listed);
  }
  return out;
}

/** Whether a listed service differs from the declared one in `cmd`, `needs` or `httpPort`. A field the listing does not carry is not compared. Pure. */
export function listedServiceDiffers(listed: ListedService, declared: BoxServiceDeclaration, cmd: string): string | null {
  if (listed.cmd !== undefined && listed.cmd !== cmd) return `cmd ${JSON.stringify(listed.cmd)} is now ${JSON.stringify(cmd)}`;
  if (listed.needs !== undefined) {
    const a = [...listed.needs].sort().join(",");
    const b = [...declared.needs].sort().join(",");
    if (a !== b) return `needs [${a}] is now [${b}]`;
  }
  if (listed.httpPort !== undefined && (listed.httpPort ?? null) !== declared.httpPort) return `httpPort ${listed.httpPort ?? "none"} is now ${declared.httpPort ?? "none"}`;
  return null;
}

/**
 * The arguments of `sprite-env services create` for a declared service.
 * `argv` is the command from {@link serviceCommandArgv}: its first word is
 * `--cmd`, the rest `--args` (comma-separated), as sprite-env and upstream
 * Sprites take them; neither runs `--cmd` through a shell. A string is split
 * on whitespace. With a `duration`, sprite-env streams the service's output
 * for that long and fails the create if the service exits in it, so
 * `--no-stream` (which returns as soon as the service is defined) is passed
 * only without one. Pure.
 */
export function spriteEnvCreateArgs(s: BoxServiceDeclaration, argv: string | readonly string[]): string[] {
  const [cmd, ...rest] = typeof argv === "string" ? argv.trim().split(/\s+/) : argv;
  return [
    "services",
    "create",
    s.name,
    "--cmd",
    cmd,
    ...(rest.length > 0 ? ["--args", rest.join(",")] : []),
    ...(s.needs.length > 0 ? ["--needs", s.needs.join(",")] : []),
    ...(s.httpPort !== null ? ["--http-port", String(s.httpPort)] : []),
    ...(s.duration !== null ? ["--duration", s.duration] : ["--no-stream"]),
  ];
}

/** The states a service is in once started: `start` leaves it be. */
const UP = new Set(["running", "starting"]);

/**
 * Apply the box block's services through sprite-env, in dependency order:
 * create a declared service the supervisor doesn't have, delete and create
 * one whose `cmd`, `needs` or `httpPort` differ from what the list reports,
 * and leave a converged one running (restart it with `restart`). Then, with
 * `start`, start each applied service that is not running.
 */
async function applyThroughSpriteEnv(args: SpriteApplyServicesArgs, signal?: AbortSignal): Promise<SpriteApplyServicesResult> {
  if (!args.box) throw new Error("spriteApplyServices: without an id it applies the box block's services through sprite-env; pass box: true (or an id and services for the Sprites API)");
  if (args.services) throw new Error("spriteApplyServices: box: true reads the services from the box block, so it takes no services beside it");
  const declared = await boxServices();
  const names = new Set(declared.map((s) => s.name));
  const unknown = (args.only ?? []).filter((n) => !names.has(n));
  if (unknown.length > 0) {
    throw new Error(`spriteApplyServices: only names ${unknown.join(", ")}, which the box block does not declare; declared: ${[...names].join(", ") || "none"}`);
  }
  const only = args.only ? new Set(args.only) : null;
  const targets = inStartOrder(declared).filter((s) => (only ? only.has(s.name) : !s.optional));
  // Expand every command before changing anything, so a missing variable fails the step with nothing half-applied.
  const commands = new Map(targets.map((s) => [s.name, serviceCommandArgv(s.name, s.cmd)]));

  const bin = findSpriteEnv(args.spriteEnv);
  if (!bin) throw new Error("spriteApplyServices: no sprite-env on PATH or in /.sprite/bin, and no sprite id to reach the Sprites API with");
  const spriteEnv = async (argv: string[]): Promise<string> => {
    try {
      return (await execFileAsync(bin, argv, { signal, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`sprite-env ${argv.slice(0, 3).join(" ")} failed: ${(e.stderr || e.message || String(err)).trim()}`);
    }
  };
  const live = new Map(parseServiceDefinitions(await spriteEnv(["services", "list"])).map((s) => [s.name, s]));

  // The supervisor gives one service the HTTP port and refuses a second holder
  // (409) while the first still has it. So a service whose listed port is not
  // the declared one is replaced first, before any service is defined with a
  // port: when the port moves from one service to another, the old holder has
  // let go of it by the time the new one asks. One whose declared needs are not
  // all defined yet can't be created early and waits for its turn below.
  const released = new Set<string>();
  for (const s of targets) {
    const cur = live.get(s.name);
    if (!cur || cur.httpPort === undefined || cur.httpPort === null || cur.httpPort === s.httpPort) continue;
    if (!s.needs.every((n) => live.has(n))) continue;
    const argv = commands.get(s.name)!;
    const why = listedServiceDiffers(cur, s, argv.join(" "));
    await spriteEnv(["services", "delete", s.name]);
    await spriteEnv(spriteEnvCreateArgs(s, argv));
    logProgress(`services: replaced ${s.name} (${why}) first, to free the HTTP port`);
    released.add(s.name);
  }

  const services: { name: string; action: ServiceApplyAction }[] = [];
  for (const s of targets) {
    if (released.has(s.name)) {
      services.push({ name: s.name, action: "replaced" });
      continue;
    }
    const argv = commands.get(s.name)!;
    const cmd = argv.join(" ");
    const cur = live.get(s.name);
    if (!cur) {
      await spriteEnv(spriteEnvCreateArgs(s, argv));
      logProgress(`services: created ${s.name}`);
      services.push({ name: s.name, action: "created" });
      continue;
    }
    const why = listedServiceDiffers(cur, s, cmd);
    if (why) {
      await spriteEnv(["services", "delete", s.name]);
      await spriteEnv(spriteEnvCreateArgs(s, argv));
      logProgress(`services: replaced ${s.name} (${why})`);
      services.push({ name: s.name, action: "replaced" });
      continue;
    }
    if (args.restart) {
      await spriteEnv(["services", "restart", s.name]);
      logProgress(`services: restarted ${s.name}`);
      services.push({ name: s.name, action: "restarted" });
      continue;
    }
    services.push({ name: s.name, action: "left" });
  }

  const started: string[] = [];
  if (args.start) {
    for (const entry of services) {
      if (entry.action !== "left" || UP.has(live.get(entry.name)?.status ?? "")) continue;
      await spriteEnv(["services", "start", entry.name]);
      logProgress(`services: started ${entry.name}`);
      entry.action = "started";
      started.push(entry.name);
    }
  }
  const applied = services.filter((e) => e.action === "created" || e.action === "replaced").map((e) => e.name);
  logProgress(`services: applied ${applied.length}/${targets.length} through sprite-env, started ${started.length}`);
  return { applied, started, services };
}
