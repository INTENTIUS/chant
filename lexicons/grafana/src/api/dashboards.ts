/**
 * Reading dashboards (#2946).
 *
 * Grafana 12 and 13 serve dashboards as Kubernetes-style resources under
 * `/apis/dashboard.grafana.app/<version>/namespaces/<ns>/dashboards/<uid>`:
 * the classic dashboard JSON in `spec`, and who manages it in
 * `metadata.annotations` and `metadata.labels` (./../ownership.ts). The
 * version is discovered once per client from the API group, preferring the
 * newest classic (v1-family) version the server serves: `v1` on 13.x,
 * `v1beta1` on 12.x. A server without the group (Grafana 11) is read over
 * `GET /api/dashboards/uid/<uid>`, which has the same JSON and no metadata
 * channel.
 *
 * ## The version branch is one place
 *
 * {@link classicDashboardOf} decides whether a stored dashboard can be read
 * as classic JSON. Everything downstream (observe, deep observe, export) only
 * ever sees its answer. A dashboard stored as v2 (the layout-and-elements
 * schema Grafana 12 introduced) is reported as not readable, with the reason,
 * rather than read through Grafana's own v2-to-v1 conversion, which drops
 * what v1 cannot hold; the importer refuses that read for the same reason
 * (`lossyV1Read`). The importer reads v2 itself (./../import/v2.ts), and
 * #2947 wires that in here: read the resource at v2 and convert it.
 */

import { looksLikeV2Dashboard } from "../detect";
import { lossyV1Read } from "../import/v2";
import type { GrafanaClient } from "./client";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
}

export const DASHBOARD_GROUP = "dashboard.grafana.app";

/** Classic-schema versions of the dashboard API, newest first. */
export const CLASSIC_DASHBOARD_VERSIONS: readonly string[] = ["v1", "v1beta1", "v0alpha1"];

/** How this server serves dashboards. */
export type DashboardApi = { readonly kind: "apis"; readonly version: string } | { readonly kind: "legacy" };

/** The dashboard API the server behind `client` serves, discovered once per client. */
export function dashboardApi(client: GrafanaClient): Promise<DashboardApi> {
  return client.once("dashboard-api", async () => {
    const group = await client.get<{ versions?: Array<{ version?: string }> }>(`/apis/${DASHBOARD_GROUP}`);
    const served = new Set((group?.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string"));
    const version = CLASSIC_DASHBOARD_VERSIONS.find((v) => served.has(v));
    return version ? { kind: "apis", version } : { kind: "legacy" };
  });
}

/** One dashboard as Grafana holds it. */
export interface LiveDashboard {
  readonly uid: string;
  /**
   * The stored resource as it came back: a `dashboard.grafana.app` resource
   * (`{ metadata, spec, status }`) or, on the legacy API, `{ dashboard, meta }`.
   * Read it through {@link classicDashboardOf}.
   */
  readonly raw: Json;
  readonly via: "apis" | "legacy";
  /** `metadata.labels`. Empty on the legacy API, which has no labels. */
  readonly labels: Readonly<Record<string, string>>;
  /** `metadata.annotations`. Empty on the legacy API. */
  readonly annotations: Readonly<Record<string, string>>;
  /** The folder's uid, when it is in one. */
  readonly folderUid?: string;
  /** The folder's title, when the read returned it (the legacy API does). */
  readonly folderTitle?: string;
  /** The request path it was read from. */
  readonly address: string;
}

/** A dashboard read: there, not there (404), or there but not readable as classic JSON. */
export type DashboardRead =
  | { readonly present: LiveDashboard }
  | { readonly absent: true; readonly address: string };

/** The request path for one dashboard on this API. */
export function dashboardPath(api: DashboardApi, namespace: string, uid: string): string {
  const id = encodeURIComponent(uid);
  return api.kind === "apis"
    ? `/apis/${DASHBOARD_GROUP}/${api.version}/namespaces/${encodeURIComponent(namespace)}/dashboards/${id}`
    : `/api/dashboards/uid/${id}`;
}

function fromResource(resource: Json, address: string): LiveDashboard {
  const metadata = isObject(resource.metadata) ? resource.metadata : {};
  const annotations = stringMap(metadata.annotations);
  const folderUid = annotations["grafana.app/folder"];
  return {
    uid: typeof metadata.name === "string" ? metadata.name : "",
    raw: resource,
    via: "apis",
    labels: stringMap(metadata.labels),
    annotations,
    ...(folderUid ? { folderUid } : {}),
    address,
  };
}

function fromLegacy(body: Json, address: string): LiveDashboard {
  const dashboard = isObject(body.dashboard) ? body.dashboard : {};
  const meta = isObject(body.meta) ? body.meta : {};
  return {
    uid: typeof dashboard.uid === "string" ? dashboard.uid : "",
    raw: body,
    via: "legacy",
    labels: {},
    annotations: {},
    ...(typeof meta.folderUid === "string" && meta.folderUid !== "" ? { folderUid: meta.folderUid } : {}),
    ...(typeof meta.folderTitle === "string" && meta.folderTitle !== "" && meta.folderUid ? { folderTitle: meta.folderTitle } : {}),
    address,
  };
}

/** Read one dashboard by uid. Throws `GrafanaApiError` for anything but a 2xx or a 404. */
export async function readDashboard(client: GrafanaClient, uid: string): Promise<DashboardRead> {
  const api = await dashboardApi(client);
  const address = dashboardPath(api, client.namespace, uid);
  const body = await client.get<Json>(address);
  if (body === undefined) return { absent: true, address };
  return { present: api.kind === "apis" ? fromResource(body, address) : fromLegacy(body, address) };
}

/** Every dashboard in the organisation, paged. */
export async function listDashboards(client: GrafanaClient): Promise<LiveDashboard[]> {
  const api = await dashboardApi(client);
  const out: LiveDashboard[] = [];
  if (api.kind === "apis") {
    const base = `/apis/${DASHBOARD_GROUP}/${api.version}/namespaces/${encodeURIComponent(client.namespace)}/dashboards`;
    let next: string | undefined;
    do {
      const page = await client.get<{ items?: unknown[]; metadata?: { continue?: string } }>(
        `${base}?limit=500${next ? `&continue=${encodeURIComponent(next)}` : ""}`,
      );
      for (const item of page?.items ?? []) {
        if (!isObject(item)) continue;
        const d = fromResource(item, `${base}/${encodeURIComponent(String((item.metadata as Json | undefined)?.name ?? ""))}`);
        if (d.uid) out.push(d);
      }
      next = page?.metadata?.continue || undefined;
    } while (next);
    return out;
  }
  for (let page = 1; ; page++) {
    const hits = (await client.get<Array<{ uid?: string }>>(`/api/search?type=dash-db&limit=1000&page=${page}`)) ?? [];
    for (const hit of hits) {
      if (typeof hit.uid !== "string") continue;
      const read = await readDashboard(client, hit.uid);
      if ("present" in read) out.push(read.present);
    }
    if (hits.length < 1000) break;
  }
  return out;
}

/**
 * The stored dashboard as classic JSON, with its uid, or why it cannot be
 * read as one. The only place the dashboard schema version branches; #2947
 * adds a v2 reader here.
 */
export function classicDashboardOf(dashboard: LiveDashboard): { json: Json } | { unsupported: string } {
  if (dashboard.via === "legacy") {
    const json = isObject(dashboard.raw.dashboard) ? dashboard.raw.dashboard : {};
    if (looksLikeV2Dashboard(json)) return { unsupported: "it is a v2 dashboard, which chant does not observe yet (#2947)" };
    return { json };
  }
  // The importer's own test for a v1 read of a v2-stored dashboard (#2947),
  // so import and observe refuse the same lossy down-conversion.
  const lossy = lossyV1Read(dashboard.raw);
  if (lossy?.failed) return { unsupported: `Grafana could not convert it from ${lossy.storedVersion || "the version it is stored at"} to the classic schema` };
  if (lossy) return { unsupported: `it is stored as a ${lossy.storedVersion} dashboard, which chant does not observe yet (#2947)` };
  const spec = isObject(dashboard.raw.spec) ? dashboard.raw.spec : undefined;
  if (!spec) return { unsupported: "the resource has no spec" };
  if (looksLikeV2Dashboard(spec)) return { unsupported: "it is a v2 dashboard, which chant does not observe yet (#2947)" };
  // The resource's name is the dashboard's uid; the spec does not repeat it.
  return { json: { ...spec, uid: dashboard.uid } };
}

/**
 * The title of the folder a dashboard is in, or undefined for the General
 * folder. One `GET /api/folders/<uid>` per folder per client.
 */
export async function folderTitleOf(client: GrafanaClient, dashboard: LiveDashboard): Promise<string | undefined> {
  if (!dashboard.folderUid) return undefined;
  if (dashboard.folderTitle) return dashboard.folderTitle;
  const uid = dashboard.folderUid;
  return client.once(`folder:${uid}`, async () => {
    const folder = await client.get<{ title?: string }>(`/api/folders/${encodeURIComponent(uid)}`);
    return typeof folder?.title === "string" ? folder.title : undefined;
  });
}
