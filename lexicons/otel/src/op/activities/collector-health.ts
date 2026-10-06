/**
 * Running collectors as resources a `ConvergeOp` observes (#3369).
 *
 * `collectorHealthObserve` returns one resource per collector, from the
 * endpoints its config declares:
 *
 * - the `health_check` extension (`service.extensions`), at its `endpoint`
 *   and `path`. At v0.130.0 it answers on `localhost:13133` at `/` by
 *   default, 200 while the collector runs, and reports no per-component
 *   status, so a 200 is all it says.
 * - the `zpages` extension, when the service enables it: `/debug/servicez`
 *   on its endpoint (default `localhost:55679`).
 * - the collector's own metrics, when `service.telemetry.metrics` declares
 *   where they are served: a `pull` reader's prometheus exporter
 *   (`host`/`port`), or the older `address`. `/metrics` on it.
 *
 * A collector whose service enables no `health_check` is `unknown`, never
 * `drifted`: nothing it declares says whether it is healthy. One that does
 * is `in-sync` when every declared endpoint answers 200, and `drifted`
 * otherwise, with each endpoint that did not in the detail.
 *
 * The config's hosts are where the collector listens, which is often
 * `0.0.0.0` or a pod address. `host` replaces the host of every endpoint (a
 * port-forward, a container's published ports), and `endpoints` replaces
 * whole URLs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { parseComponentId } from "../../model";

export type CollectorEndpointKind = "healthCheck" | "zpages" | "telemetry";

export interface ObservedCollector {
  /** The resource name. */
  name: string;
  /** The collector config file, relative to the working directory, read on each tick. */
  config?: string;
  /** The config itself, in place of `config`. */
  configObject?: Record<string, unknown>;
  /** Where the collector is reached, replacing every endpoint's host. Default: the config's host, with 0.0.0.0 and empty read as localhost. */
  host?: string;
  /** Whole URLs, replacing the ones read from the config. */
  endpoints?: Partial<Record<CollectorEndpointKind, string>>;
}

export interface CollectorHealthObserveArgs {
  collectors: ObservedCollector[];
  /** Per-request timeout, ms. Default 5000. */
  timeoutMs?: number;
  /** Probes of a failing endpoint before it counts as down. Default 2. */
  probes?: number;
  /** Time between probes, ms. Default 1000. */
  probeIntervalMs?: number;
  /** Replaces fetch. For tests. */
  _fetch?: typeof fetch;
}

export interface CollectorHealthObserveResult {
  resources: { name: string; status: "in-sync" | "drifted" | "unknown"; detail: string }[];
}

export interface DeclaredEndpoint {
  kind: CollectorEndpointKind;
  url: string;
}

const DEFAULTS = {
  healthCheck: { endpoint: "localhost:13133", path: "/" },
  zpages: { endpoint: "localhost:55679", path: "/debug/servicez" },
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `host:port`, `:port` or a URL, as host and port. A `${env:...}` host reads as unknown (empty). */
export function splitEndpoint(endpoint: string): { host: string; port: string } | undefined {
  let s = endpoint.trim().replace(/^[a-z]+:\/\//i, "");
  s = s.replace(/\/.*$/, "");
  const m = /^(.*):(\d+)$/.exec(s);
  if (!m) return undefined;
  const host = m[1].includes("${") ? "" : m[1];
  return { host, port: m[2] };
}

function urlOf(endpoint: string, path: string, host: string | undefined): string | undefined {
  const parts = splitEndpoint(endpoint);
  if (!parts) return undefined;
  let h = host ?? parts.host;
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]") h = "localhost";
  return `http://${h}:${parts.port}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The first enabled extension of `type`, and its config. */
function enabledExtension(config: Record<string, unknown>, type: string): Record<string, unknown> | undefined {
  const service = isRecord(config.service) ? config.service : {};
  const enabled = Array.isArray(service.extensions) ? service.extensions : [];
  const extensions = isRecord(config.extensions) ? config.extensions : {};
  for (const id of enabled) {
    if (typeof id !== "string" || parseComponentId(id)?.type !== type) continue;
    const body = extensions[id];
    return isRecord(body) ? body : {};
  }
  return undefined;
}

/** Where `service.telemetry.metrics` serves the collector's own metrics, as `host:port`, when the config says. */
function telemetryEndpoint(config: Record<string, unknown>): string | undefined {
  const service = isRecord(config.service) ? config.service : {};
  const telemetry = isRecord(service.telemetry) ? service.telemetry : {};
  const metrics = isRecord(telemetry.metrics) ? telemetry.metrics : undefined;
  if (!metrics || metrics.level === "none") return undefined;
  if (typeof metrics.address === "string") return metrics.address;
  const readers = Array.isArray(metrics.readers) ? metrics.readers : [];
  for (const r of readers) {
    const prom = isRecord(r) && isRecord(r.pull) && isRecord(r.pull.exporter) ? r.pull.exporter.prometheus : undefined;
    if (isRecord(prom) && (typeof prom.port === "number" || typeof prom.port === "string")) {
      const host = typeof prom.host === "string" ? prom.host : "localhost";
      return `${host}:${prom.port}`;
    }
  }
  return undefined;
}

/**
 * The endpoints a collector config declares, as URLs. `healthCheck` is
 * present only when the service enables a `health_check` extension.
 */
export function declaredEndpoints(config: Record<string, unknown>, host?: string, overrides: Partial<Record<CollectorEndpointKind, string>> = {}): DeclaredEndpoint[] {
  const out: DeclaredEndpoint[] = [];
  const push = (kind: CollectorEndpointKind, url: string | undefined) => {
    const u = overrides[kind] ?? url;
    if (u) out.push({ kind, url: u });
  };
  const hc = enabledExtension(config, "health_check");
  if (hc) {
    const endpoint = typeof hc.endpoint === "string" ? hc.endpoint : DEFAULTS.healthCheck.endpoint;
    const path = typeof hc.path === "string" ? hc.path : DEFAULTS.healthCheck.path;
    push("healthCheck", urlOf(endpoint, path, host));
  }
  const zp = enabledExtension(config, "zpages");
  if (zp) {
    const endpoint = typeof zp.endpoint === "string" ? zp.endpoint : DEFAULTS.zpages.endpoint;
    push("zpages", urlOf(endpoint, DEFAULTS.zpages.path, host));
  }
  const tel = telemetryEndpoint(config);
  if (tel) push("telemetry", urlOf(tel, "/metrics", host));
  return out;
}

const LABEL: Record<CollectorEndpointKind, string> = { healthCheck: "health_check", zpages: "zpages", telemetry: "telemetry" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function probe(f: typeof fetch, url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 200 ? undefined : `answered ${res.status}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return `did not answer (${cause ?? (err as Error).message})`;
  }
}

function collectorConfig(c: ObservedCollector): Record<string, unknown> {
  if (c.configObject) return c.configObject;
  if (!c.config) throw new Error(`collector "${c.name}" names no config`);
  const value = load(readFileSync(resolve(process.cwd(), c.config), "utf8"));
  if (!isRecord(value)) throw new Error(`collector "${c.name}": ${c.config} does not hold a YAML mapping`);
  return value;
}

/** Observe each collector through the endpoints its config declares: one resource per collector. */
export async function collectorHealthObserve(args: CollectorHealthObserveArgs): Promise<CollectorHealthObserveResult> {
  const f = args._fetch ?? fetch;
  const timeoutMs = args.timeoutMs ?? 5000;
  const probes = Math.max(1, args.probes ?? 2);
  const interval = args.probeIntervalMs ?? 1000;
  const resources: CollectorHealthObserveResult["resources"] = [];
  for (const c of args.collectors) {
    let config: Record<string, unknown>;
    try {
      config = collectorConfig(c);
    } catch (err) {
      resources.push({ name: c.name, status: "unknown", detail: `config unreadable: ${(err as Error).message}` });
      continue;
    }
    const endpoints = declaredEndpoints(config, c.host, c.endpoints);
    if (!endpoints.some((e) => e.kind === "healthCheck")) {
      resources.push({ name: c.name, status: "unknown", detail: "no health_check in service.extensions" });
      continue;
    }
    const failures: string[] = [];
    for (const e of endpoints) {
      let why: string | undefined;
      for (let i = 0; i < probes; i++) {
        why = await probe(f, e.url, timeoutMs);
        if (!why) break;
        if (i + 1 < probes) await sleep(interval);
      }
      if (why) failures.push(`${LABEL[e.kind]} ${e.url} ${why}`);
    }
    resources.push(
      failures.length === 0
        ? { name: c.name, status: "in-sync", detail: endpoints.map((e) => `${LABEL[e.kind]} ok`).join(", ") }
        : { name: c.name, status: "drifted", detail: failures.join("; ") },
    );
  }
  return { resources };
}
