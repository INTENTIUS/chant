/**
 * A Grafana API in memory, for the observe and export tests (#2946).
 *
 * Serves the routes the readers use, from a state the test sets up, in the
 * shapes Grafana 12.4.11 and 13.2.2 return (checked against both with the
 * e2e in ../observe.e2e.test.ts): the API group discovery, dashboard
 * resources under `/apis`, the legacy `/api/dashboards/uid` and
 * `/api/search`, folders, and datasources. `storedDashboard` does to a built
 * dashboard what Grafana does when it stores one.
 */

import type { GrafanaHttp, GrafanaResponse } from "./client";

type Json = Record<string, unknown>;

export interface FakeDashboard {
  /** The classic JSON, as it would be stored (see {@link storedDashboard}). */
  spec: Json;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** The version it is stored at: `v0alpha1` for a classic dashboard, `v2beta1` for one saved as v2. */
  storedVersion?: string;
  /**
   * For a dashboard stored as v2, its v2 spec, served at the v2 versions the
   * server has (`spec` is then the classic read's down-conversion). Without
   * it the v2 routes answer 404.
   */
  v2?: Json;
  folderUid?: string;
}

export interface FakeGrafanaState {
  /** `v1` (13.x), `v1beta1` (12.x), or `legacy` for a server with no `/apis/dashboard.grafana.app` (11.x). */
  api: "v1" | "v1beta1" | "legacy";
  dashboards: Record<string, FakeDashboard>;
  datasources?: Record<string, Json>;
  folders?: Record<string, string>;
  /** Answer every request with this status (a refused token: 401). */
  status?: number;
  namespace?: string;
}

const BUILTIN_ANNOTATION = {
  builtIn: 1,
  datasource: { type: "grafana", uid: "-- Grafana --" },
  enable: true,
  hide: true,
  iconColor: "rgba(0, 211, 255, 1)",
  name: "Annotations & Alerts",
  type: "dashboard",
};

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

function storePanel(p: Json): Json {
  const out: Json = { ...p };
  if (isObject(out.options) && Object.keys(out.options).length === 0) delete out.options;
  const fc = out.fieldConfig;
  if (isObject(fc) && isObject(fc.defaults) && Object.keys(fc.defaults).length === 0 && Array.isArray(fc.overrides) && fc.overrides.length === 0) delete out.fieldConfig;
  if (Array.isArray(out.panels)) out.panels = out.panels.map((c) => (isObject(c) ? storePanel(c) : c));
  return out;
}

/**
 * A built dashboard as Grafana hands it back through `/apis` (measured on
 * 12.4.11 and 13.2.2): the built-in annotation added, empty `options` and
 * `fieldConfig` dropped, `null` values dropped, and the uid moved to the
 * resource's name. The legacy route (`/api/dashboards/uid`) serves the
 * built JSON plus `id` and `version`; the fake serves this model on both,
 * which is the harder case for the legacy path.
 */
export function storedDashboard(built: Json): Json {
  const out = dropNulls(built) as Json;
  const annotations = isObject(out.annotations) && Array.isArray(out.annotations.list) ? out.annotations.list : [];
  out.annotations = { list: [BUILTIN_ANNOTATION, ...annotations] };
  if (Array.isArray(out.panels)) out.panels = out.panels.map((p) => (isObject(p) ? storePanel(p) : p));
  delete out.uid;
  return out;
}

const ok = (json: unknown): GrafanaResponse => ({ status: 200, json });
const notFound: GrafanaResponse = { status: 404, json: { message: "not found" } };

/** A {@link GrafanaHttp} over `state`, recording every request path in `calls`. */
export function fakeGrafana(state: FakeGrafanaState, calls: string[] = []): GrafanaHttp {
  const ns = state.namespace ?? "default";
  const resource = (uid: string, d: FakeDashboard): Json => ({
    apiVersion: `dashboard.grafana.app/${state.api}`,
    kind: "Dashboard",
    metadata: {
      name: uid,
      namespace: ns,
      resourceVersion: "1",
      generation: 1,
      labels: { "grafana.app/deprecatedInternalID": "1", ...(d.labels ?? {}) },
      annotations: { ...(d.folderUid ? { "grafana.app/folder": d.folderUid } : {}), ...(d.annotations ?? {}) },
    },
    spec: d.spec,
    status: { conversion: { failed: false, storedVersion: d.storedVersion ?? "v0alpha1" } },
  });
  return async (method, path) => {
    calls.push(`${method} ${path}`);
    if (state.status !== undefined) return { status: state.status, json: { message: "refused" } };
    const [route, query] = path.split("?");
    if (route === "/apis/dashboard.grafana.app") {
      if (state.api === "legacy") return notFound;
      const versions = state.api === "v1" ? ["v2", "v2beta1", "v2alpha1", "v0alpha1", "v1", "v1beta1"] : ["v1beta1", "v0alpha1", "v2beta1", "v2alpha1"];
      return ok({ kind: "APIGroup", name: "dashboard.grafana.app", versions: versions.map((version) => ({ groupVersion: `dashboard.grafana.app/${version}`, version })) });
    }
    const list = new RegExp(`^/apis/dashboard\\.grafana\\.app/${state.api}/namespaces/${ns}/dashboards$`).exec(route);
    if (list && state.api !== "legacy") return ok({ items: Object.entries(state.dashboards).map(([uid, d]) => resource(uid, d)), metadata: {} });
    const v2 = new RegExp(`^/apis/dashboard\\.grafana\\.app/(v2|v2beta1)/namespaces/${ns}/dashboards/([^/]+)$`).exec(route);
    if (v2 && state.api !== "legacy" && (state.api === "v1" || v2[1] === "v2beta1")) {
      const uid = decodeURIComponent(v2[2]);
      const d = state.dashboards[uid];
      if (!d?.v2) return notFound;
      const r = resource(uid, d);
      return ok({ ...r, apiVersion: `dashboard.grafana.app/${v2[1]}`, spec: d.v2, status: {} });
    }
    const one = new RegExp(`^/apis/dashboard\\.grafana\\.app/${state.api}/namespaces/${ns}/dashboards/([^/]+)$`).exec(route);
    if (one && state.api !== "legacy") {
      const d = state.dashboards[decodeURIComponent(one[1])];
      return d ? ok(resource(decodeURIComponent(one[1]), d)) : notFound;
    }
    const legacy = /^\/api\/dashboards\/uid\/([^/]+)$/.exec(route);
    if (legacy) {
      const uid = decodeURIComponent(legacy[1]);
      const d = state.dashboards[uid];
      if (!d) return notFound;
      const folderTitle = d.folderUid ? state.folders?.[d.folderUid] : undefined;
      return ok({
        dashboard: { ...d.spec, uid, id: 7, version: 3 },
        meta: { provisioned: true, folderUid: d.folderUid ?? "", folderTitle: folderTitle ?? "Dashboards", version: 3 },
      });
    }
    if (route === "/api/search") {
      const page = Number(new URLSearchParams(query ?? "").get("page") ?? "1");
      return ok(page === 1 ? Object.keys(state.dashboards).map((uid) => ({ uid, type: "dash-db" })) : []);
    }
    const folder = /^\/api\/folders\/([^/]+)$/.exec(route);
    if (folder) {
      const title = state.folders?.[decodeURIComponent(folder[1])];
      return title ? ok({ uid: folder[1], title }) : notFound;
    }
    if (route === "/api/datasources") return ok(Object.values(state.datasources ?? {}).map(({ secureJsonFields: _s, ...rest }) => rest));
    const ds = /^\/api\/datasources\/uid\/([^/]+)$/.exec(route);
    if (ds) {
      const d = state.datasources?.[decodeURIComponent(ds[1])];
      return d ? ok(d) : notFound;
    }
    return notFound;
  };
}

/** A datasource as `GET /api/datasources/uid/<uid>` returns one provisioned from a file. */
export function liveDatasource(ds: { name: string; type: string; uid: string; url?: string; isDefault?: boolean; jsonData?: Json; secure?: string[]; readOnly?: boolean }): Json {
  return {
    id: 2,
    uid: ds.uid,
    orgId: 1,
    name: ds.name,
    type: ds.type,
    typeLogoUrl: `public/plugins/${ds.type}/img/logo.svg`,
    access: "proxy",
    url: ds.url ?? "",
    user: "",
    database: "",
    basicAuth: false,
    basicAuthUser: "",
    withCredentials: false,
    isDefault: ds.isDefault ?? false,
    jsonData: ds.jsonData ?? {},
    secureJsonFields: Object.fromEntries((ds.secure ?? []).map((k) => [k, true])),
    version: 1,
    readOnly: ds.readOnly ?? true,
    apiVersion: "",
  };
}
