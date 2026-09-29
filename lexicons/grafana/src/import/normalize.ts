/**
 * Classic dashboard JSON in a canonical form, so two dashboards Grafana
 * treats the same compare equal.
 *
 * Grafana fills in a default for most keys a dashboard leaves out, derives
 * some keys from others (a custom variable's `options` from its `query`),
 * and resolves a query without a datasource to its panel's. A dashboard it
 * exported and the same dashboard rebuilt by chant differ in exactly those
 * ways, so both are put through `normalizeDashboard` before they are
 * compared: keys at their default are removed, derived keys are removed,
 * and references are written one way.
 *
 * The import round trip compares with it, the importer asks `isDefault`
 * whether a key it cannot carry is worth a warning (a key at its default is
 * not), and drift detection (#2946) can compare a stored dashboard with a
 * built one the same way.
 *
 * Only the dashboard, panel, row, target, variable and link levels are
 * touched. Nothing inside `options`, `fieldConfig`, `transformations` or a
 * query model is: a `null` in there (a threshold step's base value) means
 * something.
 */

import { customVariableOptions } from "../build";

type Json = Record<string, unknown>;

/** Grafana's value for a dashboard key the JSON leaves out. */
export const DASHBOARD_DEFAULTS: Readonly<Json> = {
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 0,
  links: [],
  tags: [],
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  timezone: "",
  weekStart: "",
  refresh: "",
  liveNow: false,
  preload: false,
  description: "",
};

/** Grafana's value for a panel key the JSON leaves out. */
export const PANEL_DEFAULTS: Readonly<Json> = {
  title: "",
  description: "",
  options: {},
  targets: [],
  transformations: [],
  links: [],
  transparent: false,
  hideTimeOverride: false,
  repeatDirection: "h",
};

/** Grafana's value for a row key the JSON leaves out. */
export const ROW_DEFAULTS: Readonly<Json> = {
  collapsed: false,
  panels: [],
  title: "",
};

/** Grafana's value for a variable key the JSON leaves out, whatever the variable's type. */
export const VARIABLE_DEFAULTS: Readonly<Json> = {
  hide: 0,
  skipUrlSync: false,
  label: "",
  description: "",
  multi: false,
  includeAll: false,
  allValue: "",
  regex: "",
  sort: 0,
  current: {},
  // Added by later Grafana versions, at the value that keeps the old behaviour.
  allowCustomValue: true,
  regexApplyTo: "value",
  valuesFormat: "csv",
  // Tag support was removed in Grafana 8; the keys linger in older dashboards.
  useTags: false,
  tagsQuery: "",
  tagValuesQuery: "",
  tags: [],
  queryValue: "",
};

/** Per variable type, Grafana's value for a key the JSON leaves out, over `VARIABLE_DEFAULTS`. */
export const VARIABLE_TYPE_DEFAULTS: Readonly<Record<string, Json>> = {
  query: { refresh: 1 },
  datasource: { refresh: 1 },
  interval: { refresh: 2, auto: false, auto_count: 30, auto_min: "10s" },
};

/** The defaults chant writes into a dashboard or panel link, which Grafana reads as unset. */
export const LINK_DEFAULTS: Readonly<Json> = {
  type: "link",
  icon: "external link",
  tooltip: "",
  tags: [],
  asDropdown: false,
  targetBlank: false,
  includeVars: false,
  keepTime: false,
};

/** The annotation Grafana adds to every dashboard that has none: annotations and alerts from its own database. */
export const BUILTIN_ANNOTATION: Readonly<Json> = {
  builtIn: 1,
  datasource: { type: "grafana", uid: "-- Grafana --" },
  enable: true,
  hide: true,
  iconColor: "rgba(0, 211, 255, 1)",
  name: "Annotations & Alerts",
  type: "dashboard",
};

/** Keys of a stored dashboard that belong to that copy (its database id, save counter), not to the dashboard. */
export const BOOKKEEPING_KEYS: readonly string[] = ["id", "version", "iteration"];

/** The panel datasource Grafana writes when a panel's queries go to different datasources. */
export const MIXED_UID = "-- Mixed --";

export function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** True when `value` is what Grafana assumes for `key` when it is left out (a `null` counts as left out). */
export function isDefault(defaults: Readonly<Json>, key: string, value: unknown): boolean {
  if (!(key in defaults)) return false;
  return value === null || value === undefined || deepEqual(value, defaults[key]);
}

/** Defaults for one variable type. */
export function variableDefaults(type: unknown): Json {
  return { ...VARIABLE_DEFAULTS, ...(VARIABLE_TYPE_DEFAULTS[String(type)] ?? {}) };
}

function dropDefaults(obj: Json, defaults: Readonly<Json>): void {
  for (const key of Object.keys(obj)) if (isDefault(defaults, key, obj[key])) delete obj[key];
}

const REF_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The refId Grafana (and chant) gives the query at `index` when it has none: A, B, … Z, AA, AB, … */
export function refIdAt(i: number): string {
  return i < REF_IDS.length ? REF_IDS[i] : `${REF_IDS[Math.floor(i / REF_IDS.length) - 1]}${REF_IDS[i % REF_IDS.length]}`;
}

/** `$name` and `[[name]]` written as `${name}`, the form a datasource variable's reference takes. */
export function canonicalVariableUid(uid: string): string {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(uid) ?? /^\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]$/.exec(uid);
  return m ? `\${${m[1]}}` : uid;
}

function canonicalRef(ref: unknown): unknown {
  if (!isObject(ref)) return ref;
  const out = { ...ref };
  if (typeof out.uid === "string") out.uid = canonicalVariableUid(out.uid);
  return out;
}

function sameRef(a: unknown, b: unknown): boolean {
  return isObject(a) && isObject(b) && a.type === b.type && a.uid === b.uid;
}

function isMixed(ref: unknown): boolean {
  return isObject(ref) && ref.uid === MIXED_UID;
}

/** A custom or interval variable's `query` as the list of values Grafana splits it into. */
export function splitValues(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/(?:\\,|[^,])+/g)) {
    const v = m[0].trim().replace(/\\,/g, ",");
    if (v !== "") out.push(v);
  }
  return out;
}

function normalizeLink(link: unknown): unknown {
  if (!isObject(link)) return link;
  const out = { ...link };
  dropDefaults(out, LINK_DEFAULTS);
  return out;
}

/**
 * Per datasource type, a query key's value when the target leaves it out.
 * A Tempo query without `filters` has no search filters, which `TempoQuery`
 * writes as `filters: []`.
 */
export const TARGET_DEFAULTS: Readonly<Record<string, Readonly<Json>>> = {
  tempo: { filters: [] },
};

function normalizeTarget(target: unknown, index: number, panelDatasource: unknown): unknown {
  if (!isObject(target)) return target;
  const out = { ...target };
  if (out.datasource === null || out.datasource === undefined) {
    if (panelDatasource !== undefined && !isMixed(panelDatasource)) out.datasource = panelDatasource;
    else delete out.datasource;
  } else {
    out.datasource = canonicalRef(out.datasource);
  }
  const type = isObject(out.datasource) ? out.datasource.type : undefined;
  const defaults = typeof type === "string" ? TARGET_DEFAULTS[type] : undefined;
  if (defaults) dropDefaults(out, defaults);
  if (out.refId === undefined || out.refId === null || out.refId === "") out.refId = refIdAt(index);
  return out;
}

function normalizePanel(panel: unknown): unknown {
  if (!isObject(panel)) return panel;
  if (panel.type === "row") return normalizeRow(panel);
  const out: Json = { ...panel };
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  const own = out.datasource === undefined ? undefined : canonicalRef(out.datasource);
  const targets = Array.isArray(out.targets) ? out.targets.map((t, i) => normalizeTarget(t, i, own)) : [];
  if (targets.length > 0) out.targets = targets;
  else delete out.targets;
  // The panel's datasource is the one its queries share, or Mixed when they differ.
  const refs = targets.map((t) => (isObject(t) ? t.datasource : undefined));
  if (refs.length > 0 && refs.every((r) => r !== undefined && sameRef(r, refs[0]))) out.datasource = refs[0];
  else if (own !== undefined) out.datasource = own;
  else delete out.datasource;
  const fc = isObject(out.fieldConfig) ? out.fieldConfig : {};
  out.fieldConfig = { defaults: isObject(fc.defaults) ? fc.defaults : {}, overrides: Array.isArray(fc.overrides) ? fc.overrides : [] };
  if (Array.isArray(out.links)) out.links = out.links.map(normalizeLink);
  dropDefaults(out, PANEL_DEFAULTS);
  return out;
}

function normalizeRow(row: Json): Json {
  const out: Json = { ...row };
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  if (out.datasource !== undefined) out.datasource = canonicalRef(out.datasource);
  if (Array.isArray(out.panels)) out.panels = out.panels.map(normalizePanel);
  dropDefaults(out, ROW_DEFAULTS);
  return out;
}

function normalizeVariable(variable: unknown): unknown {
  if (!isObject(variable)) return variable;
  const out: Json = { ...variable };
  const type = out.type;
  if (out.datasource === null) delete out.datasource;
  else if (out.datasource !== undefined) out.datasource = canonicalRef(out.datasource);
  const query = typeof out.query === "string" ? out.query : undefined;
  switch (type) {
    case "query":
      // `definition` is the query as the editor shows it; Grafana reads `query`.
      if (out.definition === undefined || out.definition === "" || (query !== undefined && out.definition === query)) delete out.definition;
      // Grafana runs the query again when the dashboard loads (or the time range changes).
      if (out.refresh !== 0) delete out.options;
      break;
    case "custom":
    case "interval": {
      const values = splitValues(query ?? "");
      out.query = values.join(",");
      delete out.options;
      if (type === "custom" && (!isObject(out.current) || Object.keys(out.current).length === 0) && values.length > 0) {
        // Grafana selects the first option, with a `text : value` item split into its text and value.
        const first = customVariableOptions(query ?? "")[0];
        if (first) out.current = { text: first.text, value: first.value };
      }
      out.refresh = type === "interval" ? 2 : out.refresh;
      break;
    }
    case "datasource":
      delete out.options;
      break;
    case "constant":
      // Grafana shows a constant's value from `query` and never shows the variable.
      delete out.options;
      delete out.current;
      delete out.hide;
      break;
    case "textbox": {
      delete out.options;
      const cur = isObject(out.current) ? out.current : undefined;
      if (!cur || Object.keys(cur).length === 0 || (cur.value === (query ?? "") && (cur.text === undefined || cur.text === (query ?? "")))) {
        delete out.current;
      }
      break;
    }
  }
  if (isObject(out.current)) {
    const { selected: _selected, ...current } = out.current;
    out.current = current;
  }
  dropDefaults(out, variableDefaults(type));
  return out;
}

/** The forms Grafana has written its own pseudo-datasource in, over the versions. */
function isGrafanaDatasource(ds: unknown): boolean {
  if (ds === "-- Grafana --" || ds === "grafana") return true;
  if (!isObject(ds)) return false;
  const keys = Object.keys(ds).filter((k) => ds[k] !== undefined);
  if (keys.some((k) => k !== "type" && k !== "uid")) return false;
  return (ds.uid === "-- Grafana --" || ds.uid === "grafana") && (ds.type === undefined || ds.type === "grafana" || ds.type === "datasource");
}

/** The target Grafana writes into the built-in annotation, which says what it says without one. */
const BUILTIN_ANNOTATION_TARGET = { limit: 100, matchAny: false, tags: [], type: "dashboard" };

/**
 * True for the annotation Grafana adds to every dashboard (annotations and
 * alerts from its own database), in any of the forms Grafana versions have
 * written it: a dashboard with it and one without are the same dashboard.
 */
export function isBuiltinAnnotation(a: unknown): boolean {
  if (!isObject(a) || a.builtIn !== 1 || !isGrafanaDatasource(a.datasource)) return false;
  const { datasource: _ds, target, ...rest } = a;
  if (target !== undefined && !deepEqual(target, BUILTIN_ANNOTATION_TARGET)) return false;
  const { datasource: _builtinDs, ...expected } = BUILTIN_ANNOTATION;
  return deepEqual(rest, expected);
}

function normalizeAnnotations(annotations: unknown): unknown {
  const list = isObject(annotations) && Array.isArray(annotations.list) ? annotations.list : [];
  const rest = list.filter((a) => !isBuiltinAnnotation(a));
  return rest.length === 0 ? undefined : { list: rest };
}

/**
 * The dashboard in canonical form: bookkeeping keys and keys at their
 * default removed, derived keys removed, every query with its datasource and
 * refId, every panel with the datasource its queries share. Returns a copy;
 * key order is not canonicalised (compare with `deepEqual` or `toEqual`).
 */
export function normalizeDashboard(dashboard: Json): Json {
  const out: Json = { ...dashboard };
  for (const key of BOOKKEEPING_KEYS) delete out[key];
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  const annotations = normalizeAnnotations(out.annotations);
  if (annotations === undefined) delete out.annotations;
  else out.annotations = annotations;
  if (out.refresh === false) delete out.refresh;
  if (Array.isArray(out.links)) out.links = out.links.map(normalizeLink);
  if (Array.isArray(out.panels)) out.panels = out.panels.map(normalizePanel);
  const list = isObject(out.templating) && Array.isArray(out.templating.list) ? out.templating.list : [];
  if (list.length > 0) out.templating = { list: list.map(normalizeVariable) };
  else delete out.templating;
  dropDefaults(out, DASHBOARD_DEFAULTS);
  return out;
}
