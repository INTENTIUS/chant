/**
 * A Grafana that remembers writes, in memory, for the applier's tests
 * (#2948). The read-only fake (./fake-grafana.ts) serves a fixed state for
 * observe and export; this one serves the routes the applier writes to and
 * keeps what it was sent, so a second apply sees the first one's result.
 *
 * It behaves as Grafana 12.4.11 and 13.2.2 did when the applier was checked
 * against them (../op/activities/grafana-apply.e2e.test.ts): `POST` to an
 * existing name is a 409, `PUT` needs no `resourceVersion`, a stored
 * dashboard gets the built-in annotation and Grafana's defaults
 * (`storedDashboard`), a folder with anything in it cannot be deleted over
 * `/apis`, and a library element update needs its `version`. With
 * `api: "legacy"` it is a Grafana 11: no `/apis` groups, dashboards over
 * `/api/dashboards/db` and `/api/dashboards/uid`, folders over `/api/folders`.
 */

import type { GrafanaHttp, GrafanaResponse } from "./client";
import { storedDashboard } from "./fake-grafana";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface StoredResource {
  spec: Json;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface WritableGrafanaState {
  /** `v1` (13.x), `v1beta1` (12.4), or `legacy` (11.x). */
  api: "v1" | "v1beta1" | "legacy";
  dashboards: Record<string, StoredResource>;
  /** Folders by uid; `spec.title` is the title and the `grafana.app/folder` annotation the parent. */
  folders: Record<string, StoredResource>;
  libraryElements: Record<string, Json>;
  namespace?: string;
  /** Answer every request with this status (a refused token: 401). */
  status?: number;
}

export function emptyGrafana(api: WritableGrafanaState["api"]): WritableGrafanaState {
  return { api, dashboards: {}, folders: {}, libraryElements: {} };
}

/** What Grafana fills in on a dashboard it stores, beyond `storedDashboard`. */
const DASHBOARD_DEFAULTS: Json = { editable: true, fiscalYearStartMonth: 0, graphTooltip: 0, links: [], templating: { list: [] }, timepicker: {}, timezone: "", weekStart: "" };

function store(spec: Json): Json {
  return { ...DASHBOARD_DEFAULTS, ...storedDashboard(spec) };
}

const ok = (json: unknown, status = 200): GrafanaResponse => ({ status, json });
const notFound: GrafanaResponse = { status: 404, json: { message: "not found" } };

/**
 * A {@link GrafanaHttp} over `state`, which it changes as it is written to.
 * Every request is recorded in `calls` as `METHOD path`.
 */
export function writableGrafana(state: WritableGrafanaState, calls: string[] = []): GrafanaHttp {
  const ns = state.namespace ?? "default";
  const apis = state.api !== "legacy";
  const dashRoute = new RegExp(`^/apis/dashboard\\.grafana\\.app/${state.api}/namespaces/${ns}/dashboards(?:/([^/]+))?$`);
  const folderRoute = new RegExp(`^/apis/folder\\.grafana\\.app/${state.api}/namespaces/${ns}/folders(?:/([^/]+))?$`);

  const resource = (kind: string, group: string, uid: string, r: StoredResource): Json => ({
    apiVersion: `${group}/${state.api}`,
    kind,
    metadata: { name: uid, namespace: ns, resourceVersion: "1", labels: { "grafana.app/deprecatedInternalID": "1", ...r.labels }, annotations: r.annotations },
    spec: r.spec,
    ...(kind === "Dashboard" ? { status: { conversion: { failed: false, storedVersion: "v0alpha1" } } } : {}),
  });
  const metadataOf = (body: unknown): { name: string; labels: Record<string, string>; annotations: Record<string, string> } => {
    const m = isObject(body) && isObject(body.metadata) ? body.metadata : {};
    const strings = (v: unknown) => (isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>) : {});
    const labels = strings(m.labels);
    delete labels["grafana.app/deprecatedInternalID"];
    return { name: typeof m.name === "string" ? m.name : "", labels, annotations: strings(m.annotations) };
  };
  const parentOf = (r: StoredResource) => r.annotations["grafana.app/folder"] ?? "";
  const counts = (uid: string) => ({
    dashboards: Object.values(state.dashboards).filter((d) => parentOf(d) === uid).length,
    folders: Object.values(state.folders).filter((f) => parentOf(f) === uid).length,
    librarypanels: Object.values(state.libraryElements).filter((e) => e.folderUid === uid).length,
    alertrules: 0,
  });

  return async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (state.status !== undefined) return { status: state.status, json: { message: "refused" } };
    const [route] = path.split("?");

    if (route === "/apis/dashboard.grafana.app") {
      if (!apis) return notFound;
      const versions = state.api === "v1" ? ["v2", "v0alpha1", "v1", "v1beta1"] : ["v1beta1", "v0alpha1", "v2beta1"];
      return ok({ kind: "APIGroup", versions: versions.map((version) => ({ version })) });
    }
    if (route === "/apis/folder.grafana.app") {
      if (!apis) return notFound;
      return ok({ kind: "APIGroup", versions: (state.api === "v1" ? ["v1", "v1beta1"] : ["v1beta1"]).map((version) => ({ version })) });
    }

    for (const [re, kind, group, table] of [
      [dashRoute, "Dashboard", "dashboard.grafana.app", state.dashboards],
      [folderRoute, "Folder", "folder.grafana.app", state.folders],
    ] as const) {
      const m = apis ? re.exec(route) : null;
      if (!m) continue;
      const uid = m[1] ? decodeURIComponent(m[1]) : undefined;
      if (!uid) {
        if (method === "GET") return ok({ items: Object.entries(table).map(([u, r]) => resource(kind, group, u, r)), metadata: {} });
        if (method === "POST") {
          const meta = metadataOf(body);
          if (table[meta.name]) return { status: 409, json: { message: "already exists" } };
          const spec = isObject(body) && isObject(body.spec) ? body.spec : {};
          table[meta.name] = { spec: kind === "Dashboard" ? store(spec) : spec, labels: meta.labels, annotations: meta.annotations };
          return ok(resource(kind, group, meta.name, table[meta.name]), 201);
        }
        return { status: 405, json: {} };
      }
      const r = table[uid];
      if (method === "GET") return r ? ok(resource(kind, group, uid, r)) : notFound;
      if (method === "PUT") {
        const meta = metadataOf(body);
        const spec = isObject(body) && isObject(body.spec) ? body.spec : {};
        table[uid] = { spec: kind === "Dashboard" ? store(spec) : spec, labels: meta.labels, annotations: meta.annotations };
        return ok(resource(kind, group, uid, table[uid]), r ? 200 : 201);
      }
      if (method === "DELETE") {
        if (!r) return notFound;
        if (kind === "Folder" && Object.values(counts(uid)).some((n) => n > 0)) return { status: 400, json: { message: "Folder cannot be deleted: folder is not empty" } };
        delete table[uid];
        return ok({ status: "Success" });
      }
    }

    const counted = /^\/api\/folders\/([^/]+)\/counts$/.exec(route);
    if (counted) return state.folders[decodeURIComponent(counted[1])] ? ok(counts(decodeURIComponent(counted[1]))) : notFound;

    // Legacy dashboards and folders (Grafana 11; 12.4 and 13.2 still serve them).
    const legacyDash = /^\/api\/dashboards\/uid\/([^/]+)$/.exec(route);
    if (legacyDash && method === "GET") {
      const uid = decodeURIComponent(legacyDash[1]);
      const d = state.dashboards[uid];
      if (!d) return notFound;
      return ok({ dashboard: { ...d.spec, uid, id: 7, version: 3 }, meta: { folderUid: parentOf(d), provisioned: false } });
    }
    if (route === "/api/dashboards/db" && method === "POST" && isObject(body) && isObject(body.dashboard)) {
      const { uid, id: _id, version: _v, ...spec } = body.dashboard;
      const folderUid = typeof body.folderUid === "string" ? body.folderUid : "";
      const prior = state.dashboards[String(uid)];
      state.dashboards[String(uid)] = { spec, labels: prior?.labels ?? {}, annotations: folderUid ? { "grafana.app/folder": folderUid } : {} };
      return ok({ status: "success", uid, version: 1 });
    }
    if (route === "/api/search") return ok(Object.keys(state.dashboards).map((uid) => ({ uid, type: "dash-db" })));
    const legacyFolder = /^\/api\/folders\/([^/]+)(\/move)?$/.exec(route);
    if (legacyFolder) {
      const uid = decodeURIComponent(legacyFolder[1]);
      const f = state.folders[uid];
      if (!f) return notFound;
      if (legacyFolder[2] && method === "POST" && isObject(body)) {
        f.annotations = typeof body.parentUid === "string" && body.parentUid ? { "grafana.app/folder": body.parentUid } : {};
        return ok({ uid });
      }
      if (method === "GET") return ok({ uid, title: f.spec.title, version: 1, ...(parentOf(f) ? { parentUid: parentOf(f) } : {}) });
      if (method === "PUT" && isObject(body)) {
        f.spec = { title: body.title };
        return ok({ uid, title: body.title });
      }
    }
    if (route === "/api/folders" && method === "POST" && isObject(body)) {
      const uid = String(body.uid);
      if (state.folders[uid]) return { status: 409, json: { message: "a folder with that uid already exists" } };
      state.folders[uid] = { spec: { title: body.title }, labels: {}, annotations: typeof body.parentUid === "string" && body.parentUid ? { "grafana.app/folder": body.parentUid } : {} };
      return ok({ uid, title: body.title });
    }

    // Library elements: the same on every version.
    if (route === "/api/library-elements" && method === "POST" && isObject(body)) {
      const uid = String(body.uid);
      if (state.libraryElements[uid]) return { status: 400, json: { message: "library element with that name or UID already exists" } };
      state.libraryElements[uid] = { uid, name: body.name, kind: body.kind, model: body.model, folderUid: body.folderUid ?? "", version: 1 };
      return ok({ result: state.libraryElements[uid] });
    }
    const lib = /^\/api\/library-elements\/([^/]+)$/.exec(route);
    if (lib) {
      const uid = decodeURIComponent(lib[1]);
      const el = state.libraryElements[uid];
      if (!el) return notFound;
      if (method === "GET") return ok({ result: el });
      if (method === "PATCH" && isObject(body)) {
        if (body.version !== el.version) return { status: 400, json: { message: "bad request data" } };
        state.libraryElements[uid] = { ...el, name: body.name, model: body.model, folderUid: body.folderUid ?? "", version: (el.version as number) + 1 };
        return ok({ result: state.libraryElements[uid] });
      }
    }
    return notFound;
  };
}
