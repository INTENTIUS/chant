/**
 * A sprite's services as resources a `ConvergeOp` observes and converges
 * (#2778).
 *
 * A box runs its app, hud, door and site as services a supervisor keeps
 * running: sprite-env on a sprite, and a stand-in with the same command line
 * elsewhere. No lexicon declares them, so a ConvergeOp can't observe them
 * through an environment. It can through an observer step:
 *
 * - `spriteServicesObserve` reads the supervisor's list and probes each
 *   declared service's health URL, and returns one verdict per service,
 *   `in-sync`, `drifted` or `unknown`: the `ResourceObservation` a
 *   `ConvergeOp({ observe })` evaluates its rules against, once per service.
 * - `spriteServiceRestart` restarts one service through the supervisor and
 *   waits for its health URL. It is the step of the Op a rule dispatches; the
 *   service is the one the rule fired for, which the dispatched run reads
 *   from `CHANT_CONVERGE_RESOURCE`.
 *
 * Both work in one of two ways. With no sprite `id`, they run inside the
 * sprite and call `sprite-env services` (found on PATH or in /.sprite/bin,
 * or at `spriteEnv`). With an `id`, they go through the Sprites API
 * (`spriteServiceList`, `spriteServiceStop` and `spriteServiceStart`).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { spriteServiceList, spriteServiceStart, spriteServiceStop } from "./sprite-services";
import type { SpritesHttp } from "./sprites";
import { defaultSpritesHttp } from "./sprites";

const execFileAsync = promisify(execFile);

/**
 * The variable a ConvergeOp's dispatched run reads its resource from
 * (core's `CONVERGE_RESOURCE_ENV`). Spelled out here so the lexicon runs
 * against a core that predates the export.
 */
const CONVERGE_RESOURCE_ENV = "CHANT_CONVERGE_RESOURCE";

/** One service a box declares. */
export interface DeclaredSpriteService {
  name: string;
  /** A URL that answers 200 while the service works. Without one, the supervisor's state decides. */
  health?: string;
  /** Not defined yet is not drift: the service is left out until it exists (a site before its first release). */
  optional?: boolean;
}

interface Via {
  /** The sprite, for the Sprites API. Without it, `sprite-env` inside the sprite. */
  id?: string;
  /** The `sprite-env` binary. Default: the one on PATH, else /.sprite/bin/sprite-env. */
  spriteEnv?: string;
  endpoint?: string;
  token?: string;
}

export interface SpriteServicesObserveArgs extends Via {
  /** The declared services. */
  services?: DeclaredSpriteService[];
  /** A JSON file of `{ services: [...] }`, relative to the working directory, read on each tick. */
  servicesFile?: string;
  /** Health probes before a service counts as drifted. Default 3. */
  probes?: number;
  /** Time between probes, ms. Default 1000. */
  probeIntervalMs?: number;
}

export interface SpriteServicesObserveResult {
  resources: { name: string; status: "in-sync" | "drifted" | "unknown"; detail: string }[];
  /** Optional services that aren't defined yet. */
  skipped: string[];
}

export interface SpriteServiceRestartArgs extends Via {
  /** The service. Default: the resource a ConvergeOp dispatched this run for (`CHANT_CONVERGE_RESOURCE`). */
  name?: string;
  /** Its health URL. Default: the one `services` or `servicesFile` declares for it. */
  health?: string;
  services?: DeclaredSpriteService[];
  servicesFile?: string;
  /** How long to wait for the health URL after the restart, ms. Default 60000. */
  waitMs?: number;
}

export interface SpriteServiceRestartResult {
  name: string;
  /** Whether its health URL answered, or null when it declares none. */
  healthy: boolean | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The services declared inline and in `servicesFile`, inline first. */
export function declaredServices(args: { services?: DeclaredSpriteService[]; servicesFile?: string }, cwd = process.cwd()): DeclaredSpriteService[] {
  const out = [...(args.services ?? [])];
  if (args.servicesFile) {
    const parsed = JSON.parse(readFileSync(resolve(cwd, args.servicesFile), "utf8")) as { services?: unknown };
    if (!Array.isArray(parsed.services)) throw new Error(`${args.servicesFile} has no "services" array`);
    for (const s of parsed.services as DeclaredSpriteService[]) {
      if (!s || typeof s.name !== "string") throw new Error(`${args.servicesFile}: a service has no name`);
      out.push(s);
    }
  }
  return out;
}

/** The sprite-env binary, or null when there is none. */
export function findSpriteEnv(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit) return explicit;
  for (const dir of (env.PATH ?? "").split(":").concat("/.sprite/bin")) {
    if (dir && existsSync(join(dir, "sprite-env"))) return join(dir, "sprite-env");
  }
  return null;
}

/**
 * `sprite-env services list` as name to state. A sprite's sprite-env prints
 * JSON (an array of services with `state.status`); a stand-in may print a
 * tab-separated table whose second column is the state. Pure.
 */
export function parseServicesList(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const trimmed = text.trim();
  if (!trimmed) return out;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { services?: unknown }).services ?? []);
    for (const s of list as { name?: unknown; status?: unknown; state?: { status?: unknown } }[]) {
      if (typeof s?.name !== "string") continue;
      const status = typeof s.state?.status === "string" ? s.state.status : typeof s.status === "string" ? s.status : null;
      out.set(s.name, status);
    }
    return out;
  }
  for (const line of trimmed.split("\n")) {
    const cols = line.split("\t");
    if (!cols[0]) continue;
    out.set(cols[0].trim(), cols[1]?.trim() || null);
  }
  return out;
}

async function listServices(via: Via, signal?: AbortSignal, http?: SpritesHttp): Promise<Map<string, string | null>> {
  if (via.id) {
    const list = await spriteServiceList({ id: via.id, endpoint: via.endpoint, token: via.token }, signal, http ?? defaultSpritesHttp(via.token));
    return new Map(list.map((s) => [s.name, s.state?.status ?? null]));
  }
  const bin = findSpriteEnv(via.spriteEnv);
  if (!bin) throw new Error("no sprite-env on PATH or in /.sprite/bin, and no sprite id to reach the Sprites API with");
  const { stdout } = await execFileAsync(bin, ["services", "list"], { signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return parseServicesList(stdout);
}

/** One GET of a health URL: true on 200. */
export async function probeHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(3000);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "manual" });
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

const DOWN = new Set(["stopped", "failed", "stopping"]);

/**
 * Observe the declared services: one verdict each, for a ConvergeOp's rules.
 * A service the supervisor doesn't have, or has stopped, is drifted; one
 * with a health URL is in sync when the URL answers 200 within `probes`
 * tries and drifted when it doesn't; one without is in sync while it runs.
 * When the supervisor can't be read, every service is unknown, and unknown
 * never remediates.
 */
export async function spriteServicesObserve(
  args: SpriteServicesObserveArgs,
  signal?: AbortSignal,
  http?: SpritesHttp,
): Promise<SpriteServicesObserveResult> {
  const declared = declaredServices(args);
  const probes = Math.max(1, args.probes ?? 3);
  const interval = args.probeIntervalMs ?? 1000;
  let states: Map<string, string | null>;
  try {
    states = await listServices(args, signal, http);
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      resources: declared.filter((s) => !s.optional).map((s) => ({ name: s.name, status: "unknown" as const, detail: `the supervisor could not be read: ${why}` })),
      skipped: declared.filter((s) => s.optional).map((s) => s.name),
    };
  }

  const resources: SpriteServicesObserveResult["resources"] = [];
  const skipped: string[] = [];
  for (const service of declared) {
    if (!states.has(service.name)) {
      if (service.optional) skipped.push(service.name);
      else resources.push({ name: service.name, status: "drifted", detail: "declared, but the supervisor has no such service" });
      continue;
    }
    const state = states.get(service.name) ?? null;
    if (state !== null && DOWN.has(state)) {
      resources.push({ name: service.name, status: "drifted", detail: state });
      continue;
    }
    if (service.health) {
      let ok = false;
      for (let i = 0; i < probes && !ok; i++) {
        if (i > 0) await sleep(interval);
        ok = await probeHealth(service.health, signal);
      }
      resources.push(
        ok
          ? { name: service.name, status: "in-sync", detail: `${state ?? "listed"}, ${service.health} answers 200` }
          : { name: service.name, status: "drifted", detail: `${state ?? "listed"}, ${service.health} does not answer 200 after ${probes} tries` },
      );
      continue;
    }
    resources.push(
      state === "running"
        ? { name: service.name, status: "in-sync", detail: "running" }
        : { name: service.name, status: "unknown", detail: `${state ?? "no state"}, and no health URL to probe` },
    );
  }
  return { resources, skipped };
}

/**
 * Restart one service through its supervisor and wait for its health URL.
 * The service is `name`, or the resource the ConvergeOp's rule fired for.
 * Throws when neither names one, when the supervisor refuses, or when the
 * service does not answer its health URL within `waitMs`.
 */
export async function spriteServiceRestart(
  args: SpriteServiceRestartArgs,
  signal?: AbortSignal,
  http?: SpritesHttp,
): Promise<SpriteServiceRestartResult> {
  const name = args.name ?? process.env[CONVERGE_RESOURCE_ENV];
  if (!name) {
    throw new Error(`spriteServiceRestart: no service named: pass \`name\`, or run the Op from a ConvergeOp rule, which sets ${CONVERGE_RESOURCE_ENV}`);
  }
  const health = args.health ?? (args.services || args.servicesFile ? declaredServices(args).find((s) => s.name === name)?.health : undefined);

  if (args.id) {
    const client = http ?? defaultSpritesHttp(args.token);
    await spriteServiceStop({ id: args.id, name, endpoint: args.endpoint, token: args.token }, signal, client);
    await spriteServiceStart({ id: args.id, name, endpoint: args.endpoint, token: args.token }, signal, client);
  } else {
    const bin = findSpriteEnv(args.spriteEnv);
    if (!bin) throw new Error("no sprite-env on PATH or in /.sprite/bin, and no sprite id to reach the Sprites API with");
    await execFileAsync(bin, ["services", "restart", name], { signal, timeout: 120_000 });
  }
  console.log(`restarted: ${name}`);
  if (!health) return { name, healthy: null };

  const until = Date.now() + (args.waitMs ?? 60_000);
  do {
    if (await probeHealth(health, signal)) return { name, healthy: true };
    await sleep(500);
  } while (Date.now() < until && !signal?.aborted);
  throw new Error(`${name} was restarted and does not answer ${health}`);
}
