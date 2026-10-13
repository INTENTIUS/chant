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
 * {@link classicDashboardOf} decides how a stored dashboard is read as
 * classic JSON. Everything downstream (observe, deep observe, export) only
 * ever sees its answer. A dashboard Grafana stores as v2 (the layout-and-
 * elements schema) is not read through Grafana's own v2-to-v1 conversion,
 * which drops what v1 cannot hold with nothing to show it (the importer
 * refuses that read too, `lossyV1Read`). Instead {@link readDashboard} and
 * {@link listDashboards} read it again at the newest v2 version the server
 * serves (`v2` on 13.x, `v2beta1` on 12.x), and `classicDashboardOf`
 * converts that with the importer's v2 reader (./../import/v2.ts), which
 * names everything v2 holds that the classic model cannot (#2947). Only a
 * v2-stored dashboard the server cannot serve at v2, or whose conversion
 * failed, is reported as not readable.
 */

import { looksLikeV2Dashboard } from "../detect";
import { lossyV1Read, readV2Dashboard } from "../import/v2";
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

/** v2-schema versions of the dashboard API the v2 reader understands, newest first. */
export const V2_DASHBOARD_VERSIONS: readonly string[] = ["v2", "v2beta1"];

/**
 * How this server serves dashboards: the classic version it is read at,
 * and the v2 version a dashboard stored as v2 is read at instead (#2947).
 */
export type DashboardApi = { readonly kind: "apis"; readonly version: string; readonly v2Version?: string } | { readonly kind: "legacy" };

/** The dashboard API the server behind `client` serves, discovered once per client. */
export function dashboardApi(client: GrafanaClient): Promise<DashboardApi> {
  return client.once("dashboard-api", async () => {
    const group = await client.get<{ versions?: Array<{ version?: string }> }>(`/apis/${DASHBOARD_GROUP}`);
    const served = new Set((group?.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string"));
    const version = CLASSIC_DASHBOARD_VERSIONS.find((v) => served.has(v));
    const v2Version = V2_DASHBOARD_VERSIONS.find((v) => served.has(v));
    return version ? { kind: "apis", version, ...(v2Version ? { v2Version } : {}) } : { kind: "legacy" };
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

/** The request path for one dashboard on this API (at `version` instead of the classic one, when given). */
export function dashboardPath(api: DashboardApi, namespace: string, uid: string, version?: string): string {
  const id = encodeURIComponent(uid);
  return api.kind === "apis"
    ? `/apis/${DASHBOARD_GROUP}/${version ?? api.version}/namespaces/${encodeURIComponent(namespace)}/dashboards/${id}`
    : `/api/dashboards/uid/${id}`;
}

/**
 * A classic read of a dashboard Grafana stores as v2 is a lossy
 * down-conversion: read it again at v2, where it is whole. Anything else,
 * and a v2-stored dashboard on a server with no v2 version the reader knows,
 * comes back as it was (and `classicDashboardOf` says why it cannot be read).
 */
async function atStoredVersion(client: GrafanaClient, api: DashboardApi, live: LiveDashboard): Promise<LiveDashboard> {
  if (api.kind !== "apis" || !api.v2Version) return live;
  const lossy = lossyV1Read(live.raw);
  if (!lossy || lossy.failed || !lossy.storedVersion.startsWith("v2")) return live;
  const address = dashboardPath(api, client.namespace, live.uid, api.v2Version);
  const body = await client.get<Json>(address);
  return body === undefined ? live : fromResource(body, address);
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
  if (api.kind !== "apis") return { present: fromLegacy(body, address) };
  return { present: await atStoredVersion(client, api, fromResource(body, address)) };
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
        if (d.uid) out.push(await atStoredVersion(client, api, d));
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

/** A v2 dashboard (a resource, or a bare v2 spec) as classic JSON with the uid, and what the classic form cannot hold. */
function fromV2(v2: Json, uid: string): { json: Json; warnings: string[] } | { unsupported: string } {
  try {
    const { dashboard, warnings } = readV2Dashboard(v2);
    return { json: { ...dashboard, uid: uid || dashboard.uid }, warnings };
  } catch (err) {
    return { unsupported: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The stored dashboard as classic JSON, with its uid, or why it cannot be
 * read as one. The only place the dashboard schema version branches. A v2
 * dashboard is converted by the importer's v2 reader; `warnings` then names
 * what v2 holds that the classic JSON does not (tabs, auto grids,
 * conditional rendering), and is absent for a classic dashboard.
 */
export function classicDashboardOf(dashboard: LiveDashboard): { json: Json; warnings?: string[] } | { unsupported: string } {
  if (dashboard.via === "legacy") {
    const json = isObject(dashboard.raw.dashboard) ? dashboard.raw.dashboard : {};
    if (looksLikeV2Dashboard(json)) return fromV2(json, dashboard.uid);
    return { json };
  }
  if (looksLikeV2Dashboard(dashboard.raw)) return fromV2(dashboard.raw, dashboard.uid);
  // The importer's own test for a v1 read of a v2-stored dashboard, so import
  // and observe refuse the same lossy down-conversion. readDashboard has
  // already tried the v2 read; this is a server that could not give it.
  const lossy = lossyV1Read(dashboard.raw);
  if (lossy?.failed) return { unsupported: `Grafana could not convert it from ${lossy.storedVersion || "the version it is stored at"} to the classic schema` };
  if (lossy) {
    return {
      unsupported:
        `it is stored as a ${lossy.storedVersion} dashboard and the server did not serve it at ${V2_DASHBOARD_VERSIONS.join(" or ")}; ` +
        `its ${lossy.apiVersion} copy is a lossy down-conversion, so it is not read`,
    };
  }
  const spec = isObject(dashboard.raw.spec) ? dashboard.raw.spec : undefined;
  if (!spec) return { unsupported: "the resource has no spec" };
  if (looksLikeV2Dashboard(spec)) return fromV2(spec, dashboard.uid);
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
