/**
 * A ruler and an Alertmanager in memory, for the observe and export tests
 * (#3371), and for the ruler apply target's (#3372).
 *
 * Each fake is a request handler over a state the test sets up. It answers
 * the routes ./ruler.ts and ./alertmanager.ts use, in the shapes the
 * projects document: the ruler config API's YAML (a mapping of namespace to
 * groups; one group alone at `/{namespace}/{group}`; 404 for a namespace or
 * group that is not there), `/api/v1/rules` JSON, Alertmanager's
 * `/api/v2/status` and Mimir's `/api/v1/alerts`. With `tenant` set it
 * answers 401 to a request without that `X-Scope-OrgID`, as Mimir does
 * ("no org id").
 *
 * {@link serveFake} puts a handler behind a real HTTP server on localhost,
 * so a test drives the default `fetch` transport, headers included.
 * {@link fakeHttp} hands the same handler in as a {@link PromHttp}.
 */

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dump } from "js-yaml";
import { loadPrometheusYaml } from "../import/parser";
import type { RulerKind } from "../config";
import type { PromHttp } from "./client";
import type { EvaluatedGroup, RawRuleGroup } from "./ruler";

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface FakeResponse {
  status: number;
  text: string;
  contentType?: string;
}

export type FakeHandler = (req: FakeRequest) => FakeResponse;

export interface FakeRulerState {
  kind: RulerKind;
  /** Groups by namespace (on a plain Prometheus, by rule file). */
  namespaces: Record<string, RawRuleGroup[]>;
  /** What `/api/v1/rules` reports. Defaults to every group, every rule healthy and inactive. */
  evaluated?: EvaluatedGroup[];
  /** Required `X-Scope-OrgID`. */
  tenant?: string;
  /** Answer every request with this status. */
  status?: number;
  /** Answer `/api/v1/rules` with this status (a ruler whose evaluation API is down). */
  evaluatedStatus?: number;
  prometheusPrefix?: string;
}

export interface FakeAlertmanagerState {
  kind: "alertmanager" | "mimir" | "cortex";
  /** `/api/v2/status` `config.original`. */
  original?: string;
  /** Mimir and Cortex: the uploaded config, absent for a tenant with none. */
  uploaded?: { alertmanager_config: string; template_files?: Record<string, string> };
  cluster?: string;
  version?: string;
  tenant?: string;
  status?: number;
}

const yaml = (v: unknown) => dump(v, { lineWidth: -1, noRefs: true });
const ok = (text: string, contentType = "application/yaml"): FakeResponse => ({ status: 200, text, contentType });
const json = (v: unknown): FakeResponse => ({ status: 200, text: JSON.stringify(v), contentType: "application/json" });
const notFound = (what: string): FakeResponse => ({ status: 404, text: what, contentType: "text/plain" });

function tenantRefused(tenant: string | undefined, req: FakeRequest): FakeResponse | undefined {
  if (tenant === undefined) return undefined;
  return req.headers["x-scope-orgid"] === tenant ? undefined : { status: 401, text: "no org id", contentType: "text/plain" };
}

/** What `/api/v1/rules` reports for a group nobody set an evaluation for: every rule healthy. */
export function evaluatedOf(file: string, group: RawRuleGroup): EvaluatedGroup {
  const rules = Array.isArray(group.rules) ? (group.rules as Array<Record<string, unknown>>) : [];
  return {
    name: group.name,
    file,
    interval: 60,
    rules: rules.map((r) =>
      typeof r.alert === "string"
        ? { type: "alerting", name: r.alert, query: String(r.expr), duration: 0, labels: (r.labels as Record<string, string>) ?? {}, annotations: (r.annotations as Record<string, string>) ?? {}, health: "ok", state: "inactive" }
        : { type: "recording", name: String(r.record), query: String(r.expr), labels: (r.labels as Record<string, string>) ?? {}, health: "ok" },
    ),
  };
}

/** A ruler over `state`. Writes change `state`, so a test can read back what an apply did. */
export function fakeRuler(state: FakeRulerState, calls: string[] = []): FakeHandler {
  const prefix = state.prometheusPrefix ?? (state.kind === "prometheus" ? "" : "/prometheus");
  const base = state.kind === "mimir" ? `${prefix}/config/v1/rules` : state.kind === "cortex" ? "/api/v1/rules" : state.kind === "loki" ? "/loki/api/v1/rules" : undefined;
  return (req) => {
    calls.push(`${req.method} ${req.path}`);
    if (state.status !== undefined) return { status: state.status, text: "refused" };
    const refused = tenantRefused(state.tenant, req);
    if (refused) return refused;
    const route = req.path.split("?")[0];

    if (route === `${prefix}/api/v1/rules` && req.method === "GET") {
      if (state.evaluatedStatus !== undefined) return { status: state.evaluatedStatus, text: "evaluation unavailable" };
      const groups = state.evaluated ?? Object.entries(state.namespaces).flatMap(([ns, gs]) => gs.map((g) => evaluatedOf(ns, g)));
      return json({ status: "success", data: { groups } });
    }
    if (base === undefined || (route !== base && !route.startsWith(`${base}/`))) return notFound("404 page not found");

    const parts = route.slice(base.length).split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET") {
      if (parts.length === 0) {
        const nonEmpty = Object.fromEntries(Object.entries(state.namespaces).filter(([, gs]) => gs.length > 0));
        return Object.keys(nonEmpty).length === 0 ? notFound("no rule groups found") : ok(yaml(nonEmpty));
      }
      const groups = state.namespaces[parts[0]];
      if (!groups || groups.length === 0) return notFound("no rule groups found");
      if (parts.length === 1) return ok(yaml({ [parts[0]]: groups }));
      const g = groups.find((x) => x.name === parts[1]);
      return g ? ok(yaml(g)) : notFound("group does not exist");
    }
    if (req.method === "POST" && parts.length === 1) {
      const doc = loadPrometheusYaml(req.body ?? "") as RawRuleGroup;
      const groups = (state.namespaces[parts[0]] ??= []);
      const i = groups.findIndex((x) => x.name === doc.name);
      if (i >= 0) groups[i] = doc;
      else groups.push(doc);
      return { status: 202, text: "" };
    }
    if (req.method === "DELETE" && parts.length === 2) {
      const groups = state.namespaces[parts[0]];
      const i = groups ? groups.findIndex((x) => x.name === parts[1]) : -1;
      if (i < 0) return notFound("group does not exist");
      groups.splice(i, 1);
      return { status: 202, text: "" };
    }
    return { status: 405, text: "method not allowed" };
  };
}

/** An Alertmanager over `state`: a plain one's `/api/v2/status`, or Mimir's and Cortex's `/api/v1/alerts` and per-tenant status. */
export function fakeAlertmanager(state: FakeAlertmanagerState, calls: string[] = []): FakeHandler {
  const statusPath = state.kind === "alertmanager" ? "/api/v2/status" : "/alertmanager/api/v2/status";
  return (req) => {
    calls.push(`${req.method} ${req.path}`);
    if (state.status !== undefined) return { status: state.status, text: "refused" };
    const refused = tenantRefused(state.tenant, req);
    if (refused) return refused;
    if (req.path === statusPath && req.method === "GET") {
      const original = state.kind === "alertmanager" ? state.original : state.uploaded?.alertmanager_config;
      if (original === undefined) return notFound("the Alertmanager is not configured");
      return json({
        cluster: { name: "01FAKE", peers: [{ address: "10.0.0.1:9094", name: "01FAKE" }], status: state.cluster ?? "ready" },
        config: { original },
        uptime: "2026-10-06T08:00:00.000Z",
        versionInfo: { branch: "HEAD", buildDate: "20260101-00:00:00", buildUser: "root@fake", goVersion: "go1.25", revision: "fake", version: state.version ?? "0.34.1" },
      });
    }
    if (req.path === "/api/v1/alerts" && state.kind !== "alertmanager") {
      if (req.method === "GET") {
        if (!state.uploaded) return notFound("alertmanager storage object not found");
        return ok(yaml({ template_files: state.uploaded.template_files ?? {}, alertmanager_config: state.uploaded.alertmanager_config }));
      }
      if (req.method === "POST") {
        const doc = loadPrometheusYaml(req.body ?? "") as { alertmanager_config: string; template_files?: Record<string, string> };
        state.uploaded = { alertmanager_config: doc.alertmanager_config, template_files: doc.template_files ?? {} };
        return { status: 201, text: "" };
      }
    }
    return notFound("404 page not found");
  };
}

/** A handler as a {@link PromHttp}, with no headers (a tenant-checking fake then refuses; use {@link serveFake} for those). */
export function fakeHttp(handler: FakeHandler, headers: Record<string, string> = {}): PromHttp {
  return async (method, path, body) => {
    const res = handler({ method, path, headers, body: body?.text });
    return { status: res.status, text: res.text };
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** A handler behind a real HTTP server on 127.0.0.1, on a free port. `close()` stops it. */
export async function serveFake(handler: FakeHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
    const out = handler({ method: req.method ?? "GET", path: req.url ?? "/", headers, ...(body ? { body } : {}) });
    res.writeHead(out.status, { "content-type": out.contentType ?? "text/plain" });
    res.end(out.text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
