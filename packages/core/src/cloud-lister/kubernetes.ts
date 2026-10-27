/**
 * behold#1029: Kubernetes, through API discovery and then one LIST per
 * served kind, paged with `continue`.
 *
 * The lister does not go through `@intentius/chant-k8s-client`. That client
 * builds a full read and write client, and its only network seam
 * (`requestLayer`) replaces the whole HTTP send, so the read-only guard could
 * not sit in front of its real transport. Discovery and LIST are plain GETs,
 * so they go through the lister's own guarded transport like every other
 * substrate, with the cluster's server, token and certificates passed
 * explicitly. {@link kubeTargetFromKubeconfig} reads those from a kubeconfig
 * the caller names, and refuses an exec plugin or an auth provider: those
 * are credential chains, and the lister takes static credentials only.
 *
 * Locations are namespaces. A cluster-scoped object's location is `cluster`;
 * it is listed when the scope's locations are `*` or include `cluster`. With
 * types `*`, events and leases are left out (they change on every read, so
 * every version's digest would differ) and a note says so.
 *
 * kind (the pinned `kindest/node` in choudoufu's live/kind-node-image) runs a
 * real API server, so discovery and LIST are served as on any cluster.
 */

import { readFileSync } from "node:fs";
import { parseYAML } from "../yaml";
import { buildResource, describeFailure, listedVerdict, noteTagFilter, withThrottleRetry, type ListerContext } from "./common";
import { ListerConfigError } from "./credentials";
import { maskKubernetesObject } from "./mask";
import { jsonBody, type TlsOptions, type WireResponse } from "./transport";

export interface KubernetesTarget {
  /** The API server, e.g. `https://127.0.0.1:6443`. */
  server: string;
  /** A bearer token; absent when the client certificate in `tls` authenticates. */
  token?: string;
  tls?: TlsOptions;
}

/** A served, listable kind from discovery. */
export interface ServedKind {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  /** `v1/Pod`, `apps/v1/Deployment`: the lister's `listedType`. */
  listedType: string;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const LABEL_PART = /^[A-Za-z0-9_.\-\/]+$/;
const CLUSTER_LOCATION = "cluster";
/** Left out of `types: "*"`: they change on every read. */
const CHURNING_TYPES = new Set(["v1/Event", "events.k8s.io/v1/Event", "coordination.k8s.io/v1/Lease"]);

export function listedTypeOf(group: string, version: string, kind: string): string {
  return group === "" ? `${version}/${kind}` : `${group}/${version}/${kind}`;
}

function apiUrl(target: KubernetesTarget, path: string, query?: Record<string, string>): string {
  const base = target.server.replace(/\/+$/, "");
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

function headersFor(target: KubernetesTarget): Record<string, string> {
  return { accept: "application/json", ...(target.token ? { authorization: `Bearer ${target.token}` } : {}) };
}

async function get(ctx: ListerContext, target: KubernetesTarget, path: string, query: Record<string, string> | undefined, retryDelays?: readonly number[]): Promise<WireResponse> {
  const url = apiUrl(target, path, query);
  return withThrottleRetry(() => ctx.transport.send({ substrate: "kubernetes", method: "GET", url, headers: headersFor(target) }), (r) => r.status === 429, retryDelays);
}

function k8sMessage(res: WireResponse): string {
  const body = jsonBody(res) as { message?: string; reason?: string } | undefined;
  return describeFailure(res, body?.reason, body?.message);
}

function resourcesOf(body: unknown, group: string, version: string): ServedKind[] {
  const list = (body as { resources?: Array<{ name?: string; kind?: string; namespaced?: boolean; verbs?: string[] }> } | undefined)?.resources ?? [];
  const out: ServedKind[] = [];
  for (const r of list) {
    if (!r.name || !r.kind || r.name.includes("/")) continue;
    if (!(r.verbs ?? []).includes("list")) continue;
    out.push({ group, version, kind: r.kind, plural: r.name, namespaced: r.namespaced === true, listedType: listedTypeOf(group, version, r.kind) });
  }
  return out;
}

/**
 * Every listable kind the cluster serves: the core group's `v1`, and for each
 * other group its preferred version plus any version a requested type names.
 */
export async function discover(
  ctx: ListerContext,
  target: KubernetesTarget,
  requested: ReadonlySet<string> | undefined,
  retryDelays?: readonly number[],
): Promise<ServedKind[]> {
  const kinds: ServedKind[] = [];
  const core = await get(ctx, target, "/api/v1", undefined, retryDelays);
  if (core.status >= 400) {
    ctx.notes.push({ code: core.status === 401 || core.status === 403 ? "no-credentials" : "read-failed", message: `discovery of the core group failed: ${k8sMessage(core)}` });
  } else {
    kinds.push(...resourcesOf(jsonBody(core), "", "v1"));
  }
  const groups = await get(ctx, target, "/apis", undefined, retryDelays);
  if (groups.status >= 400) {
    ctx.notes.push({ code: groups.status === 401 || groups.status === 403 ? "no-credentials" : "read-failed", message: `discovery of API groups failed: ${k8sMessage(groups)}` });
    return kinds;
  }
  const list = (jsonBody(groups) as { groups?: Array<{ name?: string; preferredVersion?: { version?: string }; versions?: Array<{ version?: string }> }> } | undefined)?.groups ?? [];
  for (const g of list) {
    if (!g.name) continue;
    const versions = new Set<string>();
    if (g.preferredVersion?.version) versions.add(g.preferredVersion.version);
    if (requested) {
      for (const v of g.versions ?? []) {
        if (v.version && [...requested].some((t) => t.startsWith(`${g.name}/${v.version}/`))) versions.add(v.version);
      }
    }
    for (const version of versions) {
      const res = await get(ctx, target, `/apis/${g.name}/${version}`, undefined, retryDelays);
      if (res.status >= 400) {
        ctx.notes.push({ code: "read-failed", message: `discovery of ${g.name}/${version} failed: ${k8sMessage(res)}` });
        continue;
      }
      kinds.push(...resourcesOf(jsonBody(res), g.name, version));
    }
  }
  return kinds;
}

/** `labelSelector` for a tag filter, or undefined. Exported for tests. */
export function labelSelector(filter: Readonly<Record<string, string>> | undefined): string | undefined {
  const entries = Object.entries(filter ?? {});
  if (entries.length === 0) return undefined;
  return entries
    .map(([k, v]) => {
      if (!LABEL_PART.test(k) || !LABEL_PART.test(v)) throw new ListerConfigError(`kubernetes label filter ${k}=${v} is not a plain label key and value`);
      return `${k}=${v}`;
    })
    .join(",");
}

export async function listKubernetes(ctx: ListerContext, target: KubernetesTarget, retryDelays?: readonly number[]): Promise<void> {
  const { scope } = ctx;
  const requested = scope.types === "*" ? undefined : new Set(scope.types);
  const selector = labelSelector(scope.tagFilter);
  noteTagFilter(ctx, "as a labelSelector on every LIST");
  const served = await discover(ctx, target, requested, retryDelays);

  let toList: ServedKind[];
  if (requested) {
    const byType = new Map(served.map((k) => [k.listedType, k]));
    toList = [];
    for (const t of requested) {
      const k = byType.get(t);
      if (k) {
        toList.push(k);
      } else {
        ctx.coverage.push({ listedType: t, location: "*", verdict: "unsupported-kind", detail: "the cluster's discovery serves no listable resource of this type" });
        ctx.notes.push({ code: "no-lister", listedType: t, message: `${t} is not a listable resource on this cluster (not served by discovery, or no list verb)` });
      }
    }
  } else {
    toList = served.filter((k) => !CHURNING_TYPES.has(k.listedType));
    const skipped = served.filter((k) => CHURNING_TYPES.has(k.listedType)).map((k) => k.listedType);
    if (skipped.length > 0) {
      ctx.notes.push({ code: "default-types", message: `types "*" left out ${skipped.join(", ")}, which change on every read; name them to list them` });
    }
  }

  const namespaces = scope.locations === "*" ? undefined : new Set(scope.locations);
  const wantCluster = scope.locations === "*" || scope.locations.includes(CLUSTER_LOCATION);
  const nsCoverage = scope.locations === "*" ? ["*"] : scope.locations.filter((l) => l !== CLUSTER_LOCATION);

  for (const k of toList) {
    if (!k.namespaced && !wantCluster) continue;
    if (k.namespaced && nsCoverage.length === 0) continue;
    const coverageLocations = k.namespaced ? nsCoverage : [CLUSTER_LOCATION];
    const path = k.group === "" ? `/api/v1/${k.plural}` : `/apis/${k.group}/${k.version}/${k.plural}`;
    const found: Parameters<typeof buildResource>[1][] = [];
    let cont: string | undefined;
    let failed: WireResponse | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = { limit: String(PAGE_SIZE) };
      if (cont) query.continue = cont;
      if (selector) query.labelSelector = selector;
      const res = await get(ctx, target, path, query, retryDelays);
      const observedAt = ctx.now().toISOString();
      if (res.status >= 400) {
        failed = res;
        break;
      }
      const body = jsonBody(res) as { items?: Array<Record<string, unknown>>; metadata?: { continue?: string } } | undefined;
      for (const item of body?.items ?? []) {
        const meta = (item.metadata ?? {}) as { name?: string; namespace?: string; uid?: string; labels?: Record<string, string>; managedFields?: unknown };
        if (!meta.name) continue;
        const ns = meta.namespace;
        if (k.namespaced && namespaces && (!ns || !namespaces.has(ns))) continue;
        const location = k.namespaced ? ns ?? "" : CLUSTER_LOCATION;
        const obj: Record<string, unknown> = { ...item, apiVersion: k.group === "" ? k.version : `${k.group}/${k.version}`, kind: k.kind };
        const { managedFields: _mf, ...restMeta } = meta;
        obj.metadata = restMeta;
        const tags: Record<string, string> = {};
        for (const [lk, lv] of Object.entries(meta.labels ?? {})) tags[lk] = String(lv);
        found.push({
          listedType: k.listedType,
          location,
          nativeId: k.namespaced ? `${ns}/${meta.name}` : meta.name,
          cloudIds: meta.uid ? [{ kind: "k8s-uid", value: meta.uid }] : [],
          tags,
          properties: maskKubernetesObject(obj),
          observedAt,
          labels: true,
        });
      }
      cont = body?.metadata?.continue || undefined;
      if (!cont) break;
    }
    if (failed) {
      const detail = k8sMessage(failed);
      const verdict = failed.status === 401 || failed.status === 403 ? "no-credentials" : failed.status === 404 ? "unsupported-kind" : "read-failed";
      for (const l of coverageLocations) ctx.coverage.push({ listedType: k.listedType, location: l, verdict, detail });
      ctx.notes.push({
        code: verdict === "no-credentials" ? "no-credentials" : verdict === "unsupported-kind" ? "no-lister" : "read-failed",
        listedType: k.listedType,
        message: `LIST ${k.listedType} failed: ${detail}`,
      });
      continue;
    }
    for (const r of found) ctx.resources.push(buildResource(ctx, r));
    for (const l of coverageLocations) ctx.coverage.push({ listedType: k.listedType, location: l, ...listedVerdict(scope) });
  }
}

/**
 * A {@link KubernetesTarget} from a kubeconfig the caller names (its text,
 * and the directory relative file paths resolve against). Static credentials
 * only: a token, a token file, or a client certificate and key. An exec
 * plugin or an auth provider is refused.
 */
export function kubeTargetFromKubeconfig(text: string, opts: { context?: string; baseDir?: string } = {}): KubernetesTarget & { contextName: string; clusterName: string } {
  const doc = parseYAML(text) as Record<string, unknown>;
  const named = <T>(list: unknown, name: string, field: string): T | undefined => {
    for (const e of Array.isArray(list) ? list : []) {
      const o = e as Record<string, unknown>;
      if (o?.name === name) return o[field] as T;
    }
    return undefined;
  };
  const contextName = opts.context ?? (typeof doc["current-context"] === "string" ? (doc["current-context"] as string) : undefined);
  if (!contextName) throw new ListerConfigError("the kubeconfig names no context and none was given");
  const context = named<Record<string, unknown>>(doc.contexts, contextName, "context");
  if (!context) throw new ListerConfigError(`the kubeconfig has no context ${contextName}`);
  const clusterName = String(context.cluster ?? "");
  const userName = String(context.user ?? "");
  const cluster = named<Record<string, unknown>>(doc.clusters, clusterName, "cluster");
  if (!cluster || typeof cluster.server !== "string") throw new ListerConfigError(`the kubeconfig's cluster ${clusterName} has no server`);
  const user = named<Record<string, unknown>>(doc.users, userName, "user") ?? {};
  if (user.exec || user["auth-provider"]) {
    throw new ListerConfigError(`the kubeconfig user ${userName} authenticates through an exec plugin or auth provider; the lister takes static credentials only (a token, or a client certificate and key)`);
  }
  const file = (p: unknown): string | undefined => {
    if (typeof p !== "string" || !p) return undefined;
    const path = p.startsWith("/") || !opts.baseDir ? p : `${opts.baseDir}/${p}`;
    return readFileSync(path, "utf8");
  };
  const b64 = (d: unknown): string | undefined => (typeof d === "string" && d ? Buffer.from(d, "base64").toString("utf8") : undefined);
  const tls: TlsOptions = {};
  const ca = b64(cluster["certificate-authority-data"]) ?? file(cluster["certificate-authority"]);
  if (ca) tls.ca = ca;
  const cert = b64(user["client-certificate-data"]) ?? file(user["client-certificate"]);
  if (cert) tls.cert = cert;
  const key = b64(user["client-key-data"]) ?? file(user["client-key"]);
  if (key) tls.key = key;
  if (cluster["insecure-skip-tls-verify"] === true) tls.insecureSkipVerify = true;
  const token = typeof user.token === "string" && user.token ? (user.token as string) : file(user.tokenFile)?.trim();
  return { server: cluster.server, ...(token ? { token } : {}), tls, contextName, clusterName };
}
