/**
 * grafana deep-observation noise rules (#2946).
 *
 * Plain data on the plugin, because core applies the same rules to the
 * declared tree (a `Dashboard`'s props, panels and queries inlined), which
 * no reader touches. The live tree is the stored dashboard put back into the
 * same vocabulary by the importer (./import/live-export.ts), so what is left
 * to name here is what the translation cannot decide: values the build
 * wrote that the author did not, values Grafana adds or drops on save, and
 * values an author wrote out that are also what happens when they are left
 * out.
 *
 * Measured against Grafana 12.4.11 and 13.2.2 (the e2e in
 * ./observe.e2e.test.ts): read over `/api/dashboards/uid`, a stored dashboard
 * differs from the built one only by the `id` and `version` Grafana adds
 * (../test/e2e/stored-model.ts). Read over `/apis/dashboard.grafana.app`, its
 * spec has no `id` or `version`, but it carries the built-in "Annotations &
 * Alerts" annotation, and empty `options` and `fieldConfig` and every `null`
 * are gone. The rest of this table is the build's own choices: panel ids,
 * grid positions, query refIds, a panel's datasource taken from its queries.
 *
 * Every rule is one of four kinds, and they are in this order below:
 *
 * 1. **Never compared**, on either side: Grafana's bookkeeping.
 * 2. **Empty is absent**, on both sides: `null`, `{}` and `[]` mean the same
 *    as leaving a key out, everywhere in a dashboard or datasource. The cost
 *    is that values added where the declaration wrote `[]` are reported as
 *    unclaimed rather than as drift.
 * 3. **Build-derived**, on the live side where the declaration has nothing:
 *    the build filled it in, so it cannot disagree with what was declared.
 * 4. **Default written out**, on the declared side where the live side has
 *    nothing: the author wrote the value Grafana assumes, which the
 *    translation leaves out.
 *
 * Rules 3 and 4 are gated on `counterpart === "absent"`, so a value the
 * author did declare is always compared, and a change away from it is drift.
 * (That relies on core walking a panel's props when it lists the declared
 * paths, which #2946 fixed in `deepPathSet`.)
 */

import type { DeepArrayElement, DeepNode, DeepNormalizationHooks } from "@intentius/chant/deep-observation";
import { DASHBOARD_TYPE } from "./dashboard";
import { DATASOURCE_TYPE, EXTERNAL_DATASOURCE_TYPE } from "./datasource";
import { registeredQueries } from "./query";
import { DASHBOARD_SCHEMA_VERSION } from "./schema/dashboard.gen";
import { BOOKKEEPING_KEYS, LINK_DEFAULTS, deepEqual, isBuiltinAnnotation } from "./import/normalize";
import { DATASOURCE_API_DEFAULTS } from "./import/live-export";

type Json = Record<string, unknown>;

/** Where a node sits in a dashboard tree, from its index-erased pattern. */
type Level = "dashboard" | "panel" | "target" | "variable" | "link";

const SEGMENT = "([^.\\[\\]]+)";
const PANEL = "panels\\[\\](?:\\.panels\\[\\])?";
const LEVELS: ReadonlyArray<[Level, RegExp]> = [
  ["dashboard", new RegExp(`^${SEGMENT}$`)],
  ["panel", new RegExp(`^${PANEL}\\.${SEGMENT}$`)],
  ["target", new RegExp(`^${PANEL}\\.targets\\[\\]\\.${SEGMENT}$`)],
  ["variable", new RegExp(`^variables\\[\\]\\.${SEGMENT}$`)],
  ["link", new RegExp(`^(?:${PANEL}\\.)?links\\[\\]\\.${SEGMENT}$`)],
];

function levelOf(pattern: string): { level: Level; key: string } | undefined {
  for (const [level, re] of LEVELS) {
    const m = re.exec(pattern);
    if (m) return { level, key: m[1] };
  }
  return undefined;
}

/**
 * Defaults in the props vocabulary: a key an author may write at this value,
 * and the translation leaves out because Grafana assumes it. The dashboard
 * and panel entries mirror `DASHBOARD_DEFAULTS` and `PANEL_DEFAULTS` in
 * ./import/normalize.ts, with `graphTooltip` spelled as `Dashboard` takes it.
 */
export const PROP_DEFAULTS: Readonly<Record<Level, Readonly<Json>>> = {
  dashboard: {
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: "default",
    links: [],
    tags: [],
    time: { from: "now-6h", to: "now" },
    timepicker: {},
    timezone: "",
    weekStart: "",
    refresh: "",
    liveNow: false,
    description: "",
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
  },
  panel: {
    title: "",
    description: "",
    options: {},
    targets: [],
    transformations: [],
    links: [],
    transparent: false,
    hideTimeOverride: false,
    repeatDirection: "h",
    // A row's.
    collapsed: false,
    panels: [],
  },
  target: {},
  variable: {
    label: "",
    description: "",
    hide: "label",
    skipUrlSync: false,
    multi: false,
    includeAll: false,
    allValue: "",
    regex: "",
    sort: 0,
    refresh: "onLoad",
    auto: false,
    autoCount: 30,
    autoMin: "10s",
  },
  link: LINK_DEFAULTS,
};

/**
 * Keys the build fills in when a declaration leaves them out, by level:
 * the dashboard's uid (from its export name) and schema version, a panel's
 * id, grid position and datasource (from its queries), a query's refId.
 * Grafana keeps what the build wrote, so undeclared, they read back as the
 * build's choice rather than as anybody's edit.
 *
 * `timezone` is here as a value, not a key: chant writes `browser` for a
 * dashboard that names none, where Grafana's own default is `""`.
 */
export const BUILD_DERIVED: Readonly<Record<Level, ReadonlySet<string>>> = {
  dashboard: new Set(["uid", "schemaVersion"]),
  panel: new Set(["id", "gridPos", "datasource", "pluginVersion"]),
  target: new Set(["refId", "datasource"]),
  // A query variable's selection is whatever the viewer last saved; the build writes one only when it is declared.
  variable: new Set(["current", "datasource"]),
  link: new Set(),
};

/** Defaults the build merges into a query from its class (`queryType: "traceql"`, `filters: []`): any key some class defaults, at that value. */
function queryDefault(key: string, value: unknown): boolean {
  for (const def of registeredQueries()) {
    const defaults = (def as { defaults?: Json }).defaults;
    if (defaults && key in defaults && deepEqual(defaults[key], value)) return true;
  }
  return false;
}

/** `[]` or a plain `{}`. Not a declarable, whose own keys are not enumerable. */
function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return (proto === Object.prototype || proto === null) && Object.keys(value).length === 0;
}

function isEmptyFieldConfig(value: unknown): boolean {
  return isEmptyContainer(value) || deepEqual(value, { defaults: {}, overrides: [] });
}

/** Any node at or under a `datasource` key: a reference, whichever form (ref, variable, entity) it takes. */
function underDatasource(pattern: string): boolean {
  return /(^|\.)datasource(\.|$)/.test(pattern);
}

function isDatasourceType(entityType: string): boolean {
  return entityType === DATASOURCE_TYPE || entityType === EXTERNAL_DATASOURCE_TYPE;
}

function pruneDatasource(node: DeepNode): boolean {
  // 1. The organisation is where it lives, not a property of it; the version is Grafana's save counter.
  if (node.pattern === "orgId" || node.pattern === "version") return true;
  // 2.
  if (node.value === null || isEmptyContainer(node.value)) return true;
  if (node.counterpart !== "absent") return false;
  if (node.side === "live") {
    // 3. The uid comes from the name when not declared; `editable` is `!readOnly`, true for one created in the UI or API.
    return node.pattern === "uid" || node.pattern === "editable";
  }
  // 4.
  if (node.pattern === "editable") return node.value === false;
  return node.pattern in DATASOURCE_API_DEFAULTS && deepEqual(DATASOURCE_API_DEFAULTS[node.pattern], node.value);
}

function pruneDashboard(node: DeepNode): boolean {
  const at = levelOf(node.pattern);

  // 1. Bookkeeping and Grafana's own additions, whatever either side says.
  if (at?.level === "dashboard" && BOOKKEEPING_KEYS.includes(at.key)) return true;
  if (/^annotations(\.list)?\[\]$/.test(node.pattern) && isBuiltinAnnotation(node.value)) return true;
  if (at?.level === "panel" && (at.key === "options" || at.key === "fieldConfig") && isEmptyFieldConfig(node.value)) return true;

  // 2. Empty is absent, on both sides whatever the other has. Grafana drops
  // every `null` when it stores a dashboard through /apis, and an empty list
  // or object means what leaving the key out means. Not gated on the
  // counterpart, which is matched by pattern: a threshold's first step has
  // `value: null` where the others have a number, and one panel's
  // `overrides: []` sits beside another's list of overrides.
  if (node.value === null || isEmptyContainer(node.value)) return true;
  if (node.counterpart !== "absent") return false;

  if (node.side === "live") {
    // 3. Build-derived.
    if (underDatasource(node.pattern)) return true;
    if (/^panels\[\](?:\.panels\[\])?\.gridPos\./.test(node.pattern)) return true;
    if (!at) return false;
    if (BUILD_DERIVED[at.level].has(at.key)) return true;
    if (at.level === "dashboard" && at.key === "timezone" && node.value === "browser") return true;
    if (at.level === "target" && queryDefault(at.key, node.value)) return true;
    if (at.level === "link" && at.key in LINK_DEFAULTS && deepEqual(LINK_DEFAULTS[at.key], node.value)) return true;
    return false;
  }

  // 4. A default written out.
  if (!at) return false;
  const defaults = PROP_DEFAULTS[at.level];
  return at.key in defaults && deepEqual(defaults[at.key], node.value);
}

export const grafanaDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    if (node.entityType === DASHBOARD_TYPE) return pruneDashboard(node);
    if (isDatasourceType(node.entityType)) return pruneDatasource(node);
    return false;
  },

  /**
   * A datasource's secrets are compared by key, never by value: Grafana
   * returns only which ones are set, the reader writes those as
   * `[REDACTED]`, and the declared values (`$__env{...}` references, or
   * worse) are masked the same way.
   */
  mask(node: DeepNode): boolean {
    return isDatasourceType(node.entityType) && /^secureJsonData\./.test(node.pattern);
  },

  /**
   * Dashboard tags are a set. Nothing else is reordered: panel order is
   * layout order, and variable and link order is the order Grafana shows
   * them in.
   */
  orderKey(element: DeepArrayElement): string | undefined {
    if (element.entityType === DASHBOARD_TYPE && element.pattern === "tags" && typeof element.element === "string") return element.element;
    return undefined;
  },
};
