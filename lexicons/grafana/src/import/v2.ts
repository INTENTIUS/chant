/**
 * Read a v2 dashboard (`dashboard.grafana.app/v2` or `v2beta1`, Grafana 13's
 * default "V2 Resource" export) as the classic (v1) dashboard JSON chant
 * builds, for `chant import` (#2947).
 *
 * The conversion follows Grafana's own v2 -> v1 conversion at v13.2.2
 * (`apps/dashboard/pkg/migration/conversion/v2alpha1_to_v1.go` and
 * `v2_to_v1_layout_conversion.md`), so what comes out is what Grafana itself
 * serves when the same dashboard is read at v1: tabs become expanded rows,
 * an auto grid gets the fixed positions Grafana computes, nested rows are
 * flattened, and row ids follow the largest panel id.
 *
 * Grafana does that silently. Here, everything v2 can say that the classic
 * model cannot is a warning: tabs, auto grids, nested rows, a hidden row
 * header after the first row, conditional rendering, section variables,
 * dashboard preferences, "show in controls menu", and any key the vendored
 * `dashboardv2` schema (`src/spec/schemas/dashboardv2.jsonschema.json`) does
 * not know. `V2_KEYS` names, per schema definition, which keys are carried
 * and which are reported; `v2.test.ts` checks it against the schema, so a
 * pin bump that adds a v2 key fails until the key is placed in one of them.
 *
 * What the classic model can hold but chant cannot yet (library panels,
 * annotations, ad hoc, group by and switch variables) is written to the
 * classic JSON as Grafana would and reported by the classic importer
 * (`./parser.ts`), as for any classic dashboard.
 *
 * A classic read of a dashboard Grafana stores as v2 is the lossy direction:
 * `storedAsV2` recognises it from the resource's
 * `status.conversion.storedVersion`, and the parser refuses it unless the
 * caller opts in.
 */

import { DASHBOARD_SCHEMA_VERSION } from "../schema/dashboard.gen";
import { isObject } from "./normalize";

type Json = Record<string, unknown>;

/**
 * Per `dashboardv2` schema definition, the keys this module reads.
 *
 * - `carried`: written into the classic dashboard (or structural, like `kind`).
 * - `reported`: v2-only, with the reason the warning gives when the key is
 *   set to anything but its default.
 */
export const V2_KEYS: Readonly<Record<string, { carried: readonly string[]; reported: Readonly<Record<string, string>> }>> = {
  Dashboard: {
    carried: ["annotations", "cursorSync", "description", "editable", "elements", "layout", "links", "liveNow", "preload", "revision", "tags", "timeSettings", "title", "variables"],
    reported: { preferences: "(dashboard preferences, the layout new sections start with, have no classic form)" },
  },
  TimeSettingsSpec: {
    carried: ["timezone", "from", "to", "autoRefresh", "autoRefreshIntervals", "quickRanges", "hideTimepicker", "weekStart", "fiscalYearStartMonth", "nowDelay"],
    reported: {},
  },
  DashboardLink: {
    carried: ["title", "type", "icon", "tooltip", "url", "tags", "asDropdown", "targetBlank", "includeVars", "keepTime", "placement"],
    reported: { origin: "(the datasource that provides the link; a classic dashboard link is always the dashboard's own)" },
  },
  PanelSpec: { carried: ["id", "title", "description", "links", "data", "vizConfig", "transparent"], reported: {} },
  LibraryPanelKindSpec: { carried: ["id", "title", "libraryPanel"], reported: {} },
  QueryGroupSpec: { carried: ["queries", "transformations", "queryOptions"], reported: {} },
  QueryOptionsSpec: {
    carried: ["timeFrom", "maxDataPoints", "timeShift", "queryCachingTTL", "interval", "cacheTimeout", "hideTimeOverride", "timeCompare"],
    reported: {},
  },
  PanelQuerySpec: { carried: ["query", "refId", "hidden"], reported: {} },
  DataQueryKind: {
    carried: ["kind", "group", "version", "datasource", "spec"],
    reported: { labels: "(query labels have no classic form)" },
  },
  TransformationKind: { carried: ["kind", "group", "spec"], reported: {} },
  TransformationSpec: { carried: ["disabled", "filter", "topic", "options"], reported: {} },
  VizConfigKind: { carried: ["kind", "group", "version", "spec"], reported: {} },
  VizConfigSpec: { carried: ["options", "fieldConfig"], reported: {} },
  GridLayoutItemSpec: { carried: ["x", "y", "width", "height", "element", "repeat"], reported: {} },
  RepeatOptions: { carried: ["mode", "value", "direction", "maxPerRow"], reported: {} },
  RowsLayoutRowSpec: {
    carried: ["title", "collapse", "hideHeader", "repeat", "layout"],
    reported: {
      fillScreen: "(a classic row does not stretch to fill the screen)",
      conditionalRendering: "(conditional rendering has no classic form, so the row always shows)",
      variables: "(section variables have no classic form)",
    },
  },
  TabsLayoutTabSpec: {
    carried: ["title", "layout", "repeat"],
    reported: {
      conditionalRendering: "(conditional rendering has no classic form, so the tab's row always shows)",
      variables: "(section variables have no classic form)",
    },
  },
  AutoGridLayoutSpec: {
    carried: ["maxColumnCount", "rowHeightMode", "rowHeight", "items"],
    reported: {
      columnWidthMode: "(a classic grid has fixed widths)",
      columnWidth: "(a classic grid has fixed widths)",
      fillScreen: "(a classic grid does not stretch to fill the screen)",
    },
  },
  AutoGridLayoutItemSpec: {
    carried: ["element", "repeat"],
    reported: { conditionalRendering: "(conditional rendering has no classic form, so the panel always shows)" },
  },
  AnnotationQuerySpec: {
    carried: ["query", "enable", "hide", "iconColor", "name", "builtIn", "filter", "mappings", "legacyOptions"],
    reported: { placement: "(an annotation toggle in the controls menu has no classic form)" },
  },
  QueryVariableSpec: {
    carried: ["name", "current", "label", "hide", "refresh", "skipUrlSync", "description", "query", "regex", "regexApplyTo", "sort", "definition", "options", "multi", "includeAll", "allValue", "allowCustomValue", "staticOptions", "staticOptionsOrder"],
    reported: { placeholder: "(a placeholder has no classic form)", origin: ORIGIN() },
  },
  TextVariableSpec: { carried: ["name", "current", "query", "label", "hide", "skipUrlSync", "description"], reported: { origin: ORIGIN() } },
  ConstantVariableSpec: { carried: ["name", "query", "current", "label", "hide", "skipUrlSync", "description"], reported: { origin: ORIGIN() } },
  DatasourceVariableSpec: {
    carried: ["name", "pluginId", "refresh", "regex", "current", "options", "multi", "includeAll", "allValue", "label", "hide", "skipUrlSync", "description", "allowCustomValue"],
    reported: { origin: ORIGIN() },
  },
  IntervalVariableSpec: {
    carried: ["name", "query", "current", "options", "auto", "auto_min", "auto_count", "refresh", "label", "hide", "skipUrlSync", "description"],
    reported: { origin: ORIGIN() },
  },
  CustomVariableSpec: {
    carried: ["name", "query", "current", "options", "multi", "includeAll", "allValue", "label", "hide", "skipUrlSync", "description", "allowCustomValue", "valuesFormat"],
    reported: { origin: ORIGIN() },
  },
  GroupByVariableKind: { carried: ["kind", "group", "datasource", "spec"], reported: { labels: "(variable labels have no classic form)" } },
  GroupByVariableSpec: {
    carried: ["name", "defaultValue", "current", "options", "multi", "label", "hide", "skipUrlSync", "description"],
    reported: { origin: ORIGIN() },
  },
  AdhocVariableKind: { carried: ["kind", "group", "datasource", "spec"], reported: { labels: "(variable labels have no classic form)" } },
  AdhocVariableSpec: {
    carried: ["name", "baseFilters", "filters", "defaultKeys", "label", "hide", "skipUrlSync", "description", "allowCustomValue", "enableGroupBy"],
    reported: { origin: ORIGIN() },
  },
  SwitchVariableSpec: {
    carried: ["name", "current", "enabledValue", "disabledValue", "label", "hide", "skipUrlSync", "description"],
    reported: { origin: ORIGIN() },
  },
};

/** Reported keys at these values say what the classic model does anyway, and are not reported. */
const V2_DEFAULTS: Readonly<Record<string, unknown>> = { columnWidthMode: "standard" };

function ORIGIN(): string {
  return "(the datasource that provides the variable; a classic variable is always the dashboard's own)";
}

/** The variable kinds, and the `V2_KEYS` entry for each one's spec. */
const VARIABLE_SPECS: Readonly<Record<string, string>> = {
  QueryVariable: "QueryVariableSpec",
  TextVariable: "TextVariableSpec",
  ConstantVariable: "ConstantVariableSpec",
  DatasourceVariable: "DatasourceVariableSpec",
  IntervalVariable: "IntervalVariableSpec",
  CustomVariable: "CustomVariableSpec",
  GroupByVariable: "GroupByVariableSpec",
  AdhocVariable: "AdhocVariableSpec",
  SwitchVariable: "SwitchVariableSpec",
};

const CURSOR_SYNC: Readonly<Record<string, number>> = { Off: 0, Crosshair: 1, Tooltip: 2 };
const VARIABLE_HIDE: Readonly<Record<string, number>> = { dontHide: 0, hideLabel: 1, hideVariable: 2 };
const VARIABLE_REFRESH: Readonly<Record<string, number>> = { never: 0, onDashboardLoad: 1, onTimeRangeChanged: 2 };
const VARIABLE_SORT: Readonly<Record<string, number>> = {
  disabled: 0,
  alphabeticalAsc: 1,
  alphabeticalDesc: 2,
  numericalAsc: 3,
  numericalDesc: 4,
  alphabeticalCaseInsensitiveAsc: 5,
  alphabeticalCaseInsensitiveDesc: 6,
  naturalAsc: 7,
  naturalDesc: 8,
};

/** A query spec holding a query that was a plain string in v1. */
const LEGACY_STRING_VALUE_KEY = "__legacyStringValue";
/** Grafana's shared "-- Dashboard --" datasource: a query that reuses another panel's results. */
const DASHBOARD_DS = "-- Dashboard --";

const GRID_COLUMNS = 24;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function obj(v: unknown): Json {
  return isObject(v) ? v : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isSet(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function quote(title: unknown): string {
  return typeof title === "string" && title !== "" ? `"${title}"` : "(untitled)";
}

/** What reading one v2 dashboard gave. */
export interface V2Read {
  /** The classic dashboard JSON. */
  dashboard: Json;
  /** What v2 said that the classic dashboard does not. */
  warnings: string[];
}

/** Collects warnings for one v2 dashboard, and the keys it saw. */
class V2Reader {
  readonly warnings: string[] = [];
  private readonly elements: Json;
  private readonly placed = new Set<string>();
  private nextRowId: number;

  constructor(private readonly spec: Json) {
    this.elements = obj(spec.elements);
    let max = 0;
    for (const el of Object.values(this.elements)) {
      const id = num(obj(obj(el).spec).id);
      if (id !== undefined && id > max) max = id;
    }
    this.nextRowId = max + 1;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** Report the keys of `value` (a `def` object) that are v2-only and set, or that the schema does not know. */
  keys(value: Json, def: string, subject: string): void {
    const table = V2_KEYS[def];
    const unknown: string[] = [];
    const reported = new Map<string, string[]>();
    for (const key of Object.keys(value)) {
      if (table.carried.includes(key)) continue;
      const why = table.reported[key];
      if (why === undefined) unknown.push(key);
      else if (isSet(value[key]) && V2_DEFAULTS[key] !== value[key]) reported.set(why, [...(reported.get(why) ?? []), key]);
    }
    for (const [why, keys] of reported) this.warn(`${subject}: ${andList(keys)} ${keys.length === 1 ? "is" : "are"} not carried ${why}`);
    if (unknown.length > 0) {
      this.warn(`${subject}: ${andList(unknown)} ${unknown.length === 1 ? "is" : "are"} not carried (not a key the dashboardv2 schema at the pin has)`);
    }
  }

  // ── datasources and queries ─────────────────────────────────────

  /** A `DataQueryKind`'s datasource as a classic `{ type, uid }`: the group is the plugin type, the name the uid. */
  datasourceOf(query: Json): Json | undefined {
    const type = str(query.group);
    const uid = str(obj(query.datasource).name);
    if (uid !== undefined && uid !== "") return type ? { type, uid } : { uid };
    return type ? { type } : undefined;
  }

  /** A `DataQueryKind`'s spec as classic query fields. */
  querySpec(query: Json, subject: string): Json {
    this.keys(query, "DataQueryKind", subject);
    const out: Json = {};
    for (const [k, v] of Object.entries(obj(query.spec))) {
      if (k === LEGACY_STRING_VALUE_KEY) {
        if (typeof v === "string") out.query = v;
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  target(q: Json, subject: string): Json {
    const spec = obj(q.spec);
    this.keys(spec, "PanelQuerySpec", subject);
    const query = obj(spec.query);
    const target: Json = this.querySpec(query, subject);
    if (typeof spec.refId === "string") target.refId = spec.refId;
    if (spec.hidden === true) target.hide = true;
    const ds = this.datasourceOf(query);
    if (ds) target.datasource = ds;
    return target;
  }

  /** The panel's datasource, derived from its queries as Grafana does: the one they share, else mixed. */
  panelDatasource(targets: Json[]): Json | undefined {
    if (targets.length === 0) return undefined;
    if (targets.filter((t) => obj(t.datasource).uid === DASHBOARD_DS).length > 1) return { type: "mixed", uid: "-- Mixed --" };
    const key = (t: Json) => `${String(obj(t.datasource).type ?? "")}\u0000${String(obj(t.datasource).uid ?? "")}`;
    const first = key(targets[0]);
    if (targets.some((t) => key(t) !== first)) return { type: "mixed", uid: "-- Mixed --" };
    const ds = obj(targets[0].datasource);
    if (ds.uid === DASHBOARD_DS) return { type: "datasource", uid: DASHBOARD_DS };
    return Object.keys(ds).length > 0 ? { ...ds } : undefined;
  }

  // ── panels ──────────────────────────────────────────────────────

  /** The element a layout item places, as a classic panel at `gridPos`; undefined when it cannot be placed. */
  element(name: unknown, gridPos: Json, repeat: Json | undefined, where: string): Json | undefined {
    if (typeof name !== "string" || !(name in this.elements)) {
      this.warn(`layout: ${where} places the element ${JSON.stringify(name)}, which the dashboard does not have, so it is left out`);
      return undefined;
    }
    if (this.placed.has(name)) {
      this.warn(`layout: ${where} places the element "${name}" a second time; a classic dashboard holds each panel once, so the second is left out`);
      return undefined;
    }
    this.placed.add(name);
    const el = obj(this.elements[name]);
    const spec = obj(el.spec);
    const panel: Json = {};
    if (el.kind === "LibraryPanel") {
      this.keys(spec, "LibraryPanelKindSpec", `library panel ${quote(spec.title)}`);
      panel.id = spec.id;
      panel.title = spec.title;
      panel.gridPos = gridPos;
      const lp = obj(spec.libraryPanel);
      panel.libraryPanel = { uid: lp.uid, name: lp.name };
      return panel;
    }
    if (el.kind !== "Panel") {
      this.warn(`element "${name}" is a ${String(el.kind)}, which is not a panel or library panel, so it is left out`);
      return undefined;
    }
    const subject = `panel ${quote(spec.title)}${spec.id !== undefined ? ` (id ${String(spec.id)})` : ""}`;
    this.keys(spec, "PanelSpec", subject);
    const viz = obj(spec.vizConfig);
    this.keys(viz, "VizConfigKind", subject);
    const vizSpec = obj(viz.spec);
    this.keys(vizSpec, "VizConfigSpec", subject);
    const data = obj(obj(spec.data).spec);
    this.keys(data, "QueryGroupSpec", subject);

    panel.id = spec.id;
    panel.title = spec.title;
    if (typeof spec.description === "string" && spec.description !== "") panel.description = spec.description;
    panel.type = str(viz.group) ?? str(viz.kind);
    if (typeof viz.version === "string" && viz.version !== "") panel.pluginVersion = viz.version;
    panel.gridPos = gridPos;
    if (repeat) Object.assign(panel, repeat);
    if (vizSpec.options !== undefined) panel.options = vizSpec.options;
    if (vizSpec.fieldConfig !== undefined) panel.fieldConfig = vizSpec.fieldConfig;
    if (arr(spec.links).length > 0) panel.links = spec.links;

    const targets = arr(data.queries).map((q) => this.target(obj(q), subject));
    const ds = this.panelDatasource(targets);
    if (ds) panel.datasource = ds;
    panel.targets = targets;

    const transformations = arr(data.transformations).map((t) => this.transformation(obj(t), subject));
    if (transformations.length > 0) panel.transformations = transformations;

    const qo = obj(data.queryOptions);
    this.keys(qo, "QueryOptionsSpec", subject);
    for (const key of V2_KEYS.QueryOptionsSpec.carried) if (qo[key] !== undefined) panel[key] = qo[key];
    if (spec.transparent !== undefined) panel.transparent = spec.transparent;
    return panel;
  }

  /** A transformation: v2 names it by `group`, v2beta1 by `kind` and `spec.id`. */
  transformation(t: Json, subject: string): Json {
    const spec = obj(t.spec);
    const v2 = t.kind === "Transformation";
    if (v2) {
      this.keys(t, "TransformationKind", subject);
      this.keys(spec, "TransformationSpec", subject);
    }
    const out: Json = { id: v2 ? t.group : (spec.id ?? t.kind) };
    for (const key of ["disabled", "filter", "topic"]) if (spec[key] !== undefined) out[key] = spec[key];
    out.options = spec.options ?? {};
    return out;
  }

  // ── layouts ─────────────────────────────────────────────────────

  private repeatOf(repeat: unknown, where: string): Json | undefined {
    if (!isObject(repeat)) return undefined;
    if (repeat.mode !== undefined && repeat.mode !== "variable") {
      this.warn(`layout: ${where} repeats by ${String(repeat.mode)}, which a classic dashboard cannot, so it does not repeat`);
      return undefined;
    }
    if (typeof repeat.value !== "string" || repeat.value === "") return undefined;
    const out: Json = { repeat: repeat.value };
    if (repeat.direction === "h" || repeat.direction === "v") out.repeatDirection = repeat.direction;
    if (typeof repeat.maxPerRow === "number") out.maxPerRow = repeat.maxPerRow;
    return out;
  }

  /** A grid's items, each moved down by `dy`. */
  grid(layout: Json, dy: number, where: string): Json[] {
    const out: Json[] = [];
    for (const item of arr(obj(layout.spec).items)) {
      const spec = obj(obj(item).spec);
      this.keys(spec, "GridLayoutItemSpec", `layout: ${where}`);
      const gridPos = { h: spec.height, w: spec.width, x: spec.x, y: (num(spec.y) ?? 0) + dy };
      const repeat = isObject(spec.repeat) ? (this.keys(spec.repeat, "RepeatOptions", `layout: ${where}`), this.repeatOf(spec.repeat, where)) : undefined;
      const panel = this.element(obj(spec.element).name, gridPos, repeat, where);
      if (panel) out.push(panel);
    }
    return out;
  }

  /** An auto grid's items at the fixed positions Grafana gives them, from `y`. */
  autoGrid(layout: Json, y: number, where: string): Json[] {
    const spec = obj(layout.spec);
    this.keys(spec, "AutoGridLayoutSpec", `layout: ${where}`);
    const maxColumns = num(spec.maxColumnCount) !== undefined && (spec.maxColumnCount as number) > 0 ? (spec.maxColumnCount as number) : 3;
    const w = Math.trunc(GRID_COLUMNS / maxColumns);
    const heights: Record<string, number> = { short: 5, standard: 9, tall: 14 };
    let h = heights[String(spec.rowHeightMode)] ?? 9;
    if (spec.rowHeightMode === "custom" && typeof spec.rowHeight === "number" && spec.rowHeight > 0) h = Math.ceil(spec.rowHeight / 38);
    const items = arr(spec.items);
    this.warn(
      `layout: ${where} is an auto grid, which a classic dashboard does not have. Its ${items.length} ${items.length === 1 ? "panel is" : "panels are"} ` +
        `placed on a fixed grid, ${maxColumns} to a row at ${w}x${h}, as Grafana places them when it reads the dashboard at v1, and no longer resize with the screen`,
    );
    const out: Json[] = [];
    let x = 0;
    for (const item of items) {
      const itemSpec = obj(obj(item).spec);
      this.keys(itemSpec, "AutoGridLayoutItemSpec", `layout: a panel in ${where}`);
      let repeat: Json | undefined;
      if (isObject(itemSpec.repeat)) {
        repeat = this.repeatOf({ ...itemSpec.repeat, direction: "h", maxPerRow: maxColumns }, where);
      }
      const panel = this.element(obj(itemSpec.element).name, { h, w, x, y }, repeat, where);
      if (panel) out.push(panel);
      x += w;
      if (x >= GRID_COLUMNS) {
        x = 0;
        y += h;
      }
    }
    return out;
  }

  private bottom(panels: Json[], from: number): number {
    let max = from;
    for (const p of panels) {
      const g = obj(p.gridPos);
      const end = (num(g.y) ?? 0) + (num(g.h) ?? 0);
      if (end > max) max = end;
    }
    return max;
  }

  private rowPanel(title: unknown, y: number, extra: Json): Json {
    const row: Json = { type: "row", id: this.nextRowId++, title: typeof title === "string" ? title : "", gridPos: { h: 1, w: GRID_COLUMNS, x: 0, y }, ...extra };
    return row;
  }

  /** Panels of a layout that is not rows or tabs, from `y`, and where they end. */
  private flat(layout: Json, y: number, where: string): { panels: Json[]; end: number } {
    if (layout.kind === "GridLayout") {
      const panels = this.grid(layout, y, where);
      return { panels, end: this.bottom(panels, y) };
    }
    if (layout.kind === "AutoGridLayout") {
      const panels = this.autoGrid(layout, y, where);
      return { panels, end: this.bottom(panels, y) };
    }
    this.warn(`layout: ${where} has a ${String(layout.kind)}, which is not a layout chant reads, so its panels are left out`);
    return { panels: [], end: y };
  }

  /** Rows or tabs, flattened into classic rows and panels from `y`. */
  sections(layout: Json, y: number, where: string): { panels: Json[]; end: number } {
    const panels: Json[] = [];
    let at = y;
    if (layout.kind === "RowsLayout") {
      arr(obj(layout.spec).rows).forEach((row, i) => {
        const r = this.row(obj(obj(row).spec), at, i, where);
        panels.push(...r.panels);
        at = r.end;
      });
    } else if (layout.kind === "TabsLayout") {
      const tabs = arr(obj(layout.spec).tabs).map((t) => obj(obj(t).spec));
      this.warn(
        `layout: ${where === "the dashboard" ? "the dashboard's" : `${where}'s`} tabs ${andList(tabs.map((t) => quote(t.title)))} become expanded rows, ` +
          "since a classic dashboard has no tabs: every tab's panels show on one page, one after another",
      );
      for (const tab of tabs) {
        const r = this.tab(tab, at);
        panels.push(...r.panels);
        at = r.end;
      }
    } else {
      return this.flat(layout, y, where);
    }
    return { panels, end: at };
  }

  private row(spec: Json, y: number, index: number, parent: string): { panels: Json[]; end: number } {
    const where = `the row ${quote(spec.title)}`;
    this.keys(spec, "RowsLayoutRowSpec", `layout: ${where}`);
    const hidden = spec.hideHeader === true;
    const layout = obj(spec.layout);
    const panels: Json[] = [];
    let at = y;
    if (hidden && (index > 0 || parent !== "the dashboard")) {
      this.warn(
        `layout: ${where} has a hidden header, which a classic dashboard has only for the panels above its first row; ` +
          "here its panels follow the row before them, so they become part of that row",
      );
    }
    if (layout.kind === "RowsLayout" || layout.kind === "TabsLayout") {
      if (!hidden) {
        panels.push(this.rowPanel(spec.title, at, { collapsed: false, panels: [] }));
        at++;
      }
      if (spec.collapse === true) this.warn(`layout: ${where} is collapsed, but it holds rows or tabs, which a classic row cannot, so it is written expanded`);
      if (layout.kind === "RowsLayout") this.warn(`layout: the rows inside ${where} come after it as rows of their own, since classic rows do not nest`);
      const nested = this.sections(layout, at, where);
      panels.push(...nested.panels);
      return { panels, end: this.bottom(nested.panels, at) };
    }
    const collapsed = spec.collapse === true;
    if (!hidden) {
      const extra: Json = { collapsed };
      const repeat = this.repeatOf(spec.repeat, where);
      if (repeat) extra.repeat = repeat.repeat;
      const row = this.rowPanel(spec.title, at, extra);
      at++;
      if (collapsed) {
        const inner = this.flat(layout, at, where);
        row.panels = inner.panels;
        panels.push(row);
        return { panels, end: at };
      }
      row.panels = [];
      panels.push(row);
    }
    const inner = this.flat(layout, at, where);
    panels.push(...inner.panels);
    return { panels, end: Math.max(inner.end, at) };
  }

  private tab(spec: Json, y: number): { panels: Json[]; end: number } {
    const where = `the tab ${quote(spec.title)}`;
    this.keys(spec, "TabsLayoutTabSpec", `layout: ${where}`);
    const extra: Json = { collapsed: false, panels: [] };
    const repeat = this.repeatOf(spec.repeat, where);
    if (repeat) extra.repeat = repeat.repeat;
    const panels: Json[] = [this.rowPanel(spec.title, y, extra)];
    const layout = obj(spec.layout);
    if (layout.kind === "RowsLayout") this.warn(`layout: the rows inside ${where} come after its row as rows of their own, since classic rows do not nest`);
    const inner = this.sections(layout, y + 1, where);
    panels.push(...inner.panels);
    return { panels, end: Math.max(inner.end, y + 1) };
  }

  /** Every element no layout item placed. */
  unplaced(): void {
    const left = Object.keys(this.elements).filter((n) => !this.placed.has(n));
    if (left.length > 0) {
      this.warn(`elements: ${left.map((n) => `"${n}"`).join(", ")} ${left.length === 1 ? "is" : "are"} not placed in the layout, so Grafana does not show ${left.length === 1 ? "it" : "them"} and ${left.length === 1 ? "it is" : "they are"} left out`);
    }
  }

  // ── variables ───────────────────────────────────────────────────

  private current(v: unknown): Json {
    const c = obj(v);
    return { text: c.text ?? "", value: c.value ?? "" };
  }

  variable(kind: Json): Json | undefined {
    const k = String(kind.kind);
    const def = VARIABLE_SPECS[k];
    const spec = obj(kind.spec);
    const subject = `variable "${String(spec.name ?? "")}"`;
    if (!def) {
      this.warn(`${subject} is a ${k}, which is not a variable kind the dashboardv2 schema at the pin has, so it is left out`);
      return undefined;
    }
    if (k === "GroupByVariable" || k === "AdhocVariable") this.keys(kind, `${k}Kind`, subject);
    this.keys(spec, def, subject);

    const out: Json = { name: spec.name };
    const hide = str(spec.hide);
    if (hide === "inControlsMenu") {
      this.warn(`${subject}: hide is not carried (it shows in the controls menu, which a classic dashboard does not have, so it shows in the variable bar)`);
    } else if (hide !== undefined && hide in VARIABLE_HIDE) {
      out.hide = VARIABLE_HIDE[hide];
    }
    if (spec.label !== undefined) out.label = spec.label;
    if (spec.description !== undefined) out.description = spec.description;
    if (spec.skipUrlSync !== undefined) out.skipUrlSync = spec.skipUrlSync;
    const refresh = (v: unknown) => (typeof v === "string" && v in VARIABLE_REFRESH ? VARIABLE_REFRESH[v] : undefined);
    const copy = (...keys: string[]) => {
      for (const key of keys) if (spec[key] !== undefined) out[key] = spec[key];
    };

    switch (k) {
      case "QueryVariable": {
        out.type = "query";
        const query = obj(spec.query);
        const q = this.querySpec(query, subject);
        const legacy = obj(query.spec)[LEGACY_STRING_VALUE_KEY];
        out.query = typeof legacy === "string" ? legacy : q;
        const ds = this.datasourceOf(query);
        if (ds) out.datasource = ds;
        if (refresh(spec.refresh) !== undefined) out.refresh = refresh(spec.refresh);
        if (typeof spec.sort === "string" && spec.sort in VARIABLE_SORT) out.sort = VARIABLE_SORT[spec.sort];
        copy("regex", "regexApplyTo", "definition", "multi", "includeAll", "allValue", "allowCustomValue", "staticOptions", "staticOptionsOrder", "options");
        out.current = this.current(spec.current);
        break;
      }
      case "DatasourceVariable":
        out.type = "datasource";
        out.query = spec.pluginId;
        if (refresh(spec.refresh) !== undefined) out.refresh = refresh(spec.refresh);
        copy("regex", "multi", "includeAll", "allValue", "allowCustomValue", "options");
        out.current = this.current(spec.current);
        break;
      case "CustomVariable":
        out.type = "custom";
        copy("query", "multi", "includeAll", "allValue", "allowCustomValue", "valuesFormat", "options");
        out.current = this.current(spec.current);
        break;
      case "ConstantVariable":
        out.type = "constant";
        out.hide = 2; // Grafana always hides a constant.
        copy("query");
        out.current = this.current(spec.current);
        break;
      case "IntervalVariable":
        out.type = "interval";
        copy("query", "auto", "auto_min", "auto_count", "options");
        if (refresh(spec.refresh) !== undefined) out.refresh = refresh(spec.refresh);
        out.current = this.current(spec.current);
        break;
      case "TextVariable":
        out.type = "textbox";
        copy("query");
        out.current = this.current(spec.current);
        break;
      case "GroupByVariable": {
        out.type = "groupby";
        const ds = this.datasourceOf(kind);
        if (ds) out.datasource = ds;
        copy("multi", "options");
        out.current = this.current(spec.current);
        if (spec.defaultValue !== undefined) out.defaultValue = this.current(spec.defaultValue);
        break;
      }
      case "AdhocVariable": {
        out.type = "adhoc";
        const ds = this.datasourceOf(kind);
        if (ds) out.datasource = ds;
        copy("allowCustomValue", "enableGroupBy");
        for (const key of ["filters", "baseFilters", "defaultKeys"]) if (arr(spec[key]).length > 0) out[key] = spec[key];
        break;
      }
      case "SwitchVariable":
        out.type = "switch";
        out.query = "";
        out.current = { text: spec.current, value: spec.current };
        out.options = [
          { text: spec.enabledValue, value: spec.enabledValue, selected: spec.current === spec.enabledValue },
          { text: spec.disabledValue, value: spec.disabledValue, selected: spec.current === spec.disabledValue },
        ];
        break;
    }
    return out;
  }

  // ── annotations, links, time ────────────────────────────────────

  annotation(kind: Json): Json {
    const spec = obj(kind.spec);
    const subject = `annotation ${quote(spec.name)}`;
    this.keys(spec, "AnnotationQuerySpec", subject);
    const out: Json = { name: spec.name, enable: spec.enable, hide: spec.hide, iconColor: spec.iconColor };
    if (spec.builtIn === true) {
      out.builtIn = 1;
      out.type = "dashboard";
    }
    const query = obj(spec.query);
    const ds = this.datasourceOf(query);
    if (ds) out.datasource = ds;
    const target = this.querySpec(query, subject);
    if (Object.keys(target).length > 0) out.target = target;
    if (isObject(spec.filter) && Object.keys(spec.filter).length > 0) out.filter = spec.filter;
    if (isObject(spec.mappings) && Object.keys(spec.mappings).length > 0) out.mappings = spec.mappings;
    const reserved = new Set(["name", "enable", "hide", "iconColor", "datasource", "target", "filter", "builtIn", "placement", "mappings"]);
    for (const [k, v] of Object.entries(obj(spec.legacyOptions))) if (!reserved.has(k)) out[k] = v;
    return out;
  }

  link(link: Json): Json {
    this.keys(link, "DashboardLink", `dashboard link ${quote(link.title)}`);
    const { origin: _origin, ...rest } = link;
    return rest;
  }

  time(ts: Json, d: Json): void {
    this.keys(ts, "TimeSettingsSpec", "time settings");
    d.time = { from: str(ts.from) || "now-6h", to: str(ts.to) || "now" };
    if (ts.timezone !== undefined) d.timezone = ts.timezone;
    if (ts.autoRefresh !== undefined) d.refresh = ts.autoRefresh;
    if (ts.fiscalYearStartMonth !== undefined) d.fiscalYearStartMonth = ts.fiscalYearStartMonth;
    if (ts.weekStart !== undefined) d.weekStart = ts.weekStart;
    const timepicker: Json = {};
    if (arr(ts.autoRefreshIntervals).length > 0) timepicker.refresh_intervals = ts.autoRefreshIntervals;
    if (ts.hideTimepicker === true) timepicker.hidden = true;
    if (ts.nowDelay !== undefined) timepicker.nowDelay = ts.nowDelay;
    if (arr(ts.quickRanges).length > 0) {
      timepicker.quick_ranges = arr(ts.quickRanges).map((r) => ({ display: obj(r).display, from: obj(r).from, to: obj(r).to }));
    }
    if (Object.keys(timepicker).length > 0) d.timepicker = timepicker;
  }

  // ── the dashboard ───────────────────────────────────────────────

  read(uid: string | undefined): Json {
    const s = this.spec;
    this.keys(s, "Dashboard", "dashboard");
    const d: Json = {};
    d.annotations = { list: arr(s.annotations).map((a) => this.annotation(obj(a))) };
    if (s.description !== undefined) d.description = s.description;
    d.editable = s.editable ?? true;
    d.graphTooltip = CURSOR_SYNC[String(s.cursorSync)] ?? 0;
    if (s.liveNow !== undefined) d.liveNow = s.liveNow;
    if (s.preload !== undefined) d.preload = s.preload;
    if (s.revision !== undefined) d.revision = s.revision;
    if (arr(s.links).length > 0) d.links = arr(s.links).map((l) => this.link(obj(l)));
    const layout = obj(s.layout);
    d.panels = this.sections(layout, 0, "the dashboard").panels;
    this.unplaced();
    d.schemaVersion = DASHBOARD_SCHEMA_VERSION;
    if (arr(s.tags).length > 0) d.tags = s.tags;
    const variables = arr(s.variables)
      .map((v) => this.variable(obj(v)))
      .filter((v): v is Json => v !== undefined);
    if (variables.length > 0) d.templating = { list: variables };
    this.time(obj(s.timeSettings), d);
    d.title = s.title ?? "";
    if (uid !== undefined && uid !== "") d.uid = uid;
    return d;
  }
}

/** The `apiVersion` of a `dashboard.grafana.app` resource, e.g. `v2beta1`; undefined for anything else. */
function resourceVersion(data: Json): string | undefined {
  const m = /^dashboard\.grafana\.app\/(.+)$/.exec(String(data.apiVersion ?? ""));
  return m ? m[1] : undefined;
}

/**
 * Read a v2 dashboard: a `dashboard.grafana.app/v2` or `v2beta1` resource,
 * or a bare v2 spec. Throws for `v2alpha1`, whose panel queries have another
 * shape; Grafana serves every stored dashboard at v2, so the fix is to read
 * it there.
 */
export function readV2Dashboard(data: Json): V2Read {
  const version = resourceVersion(data);
  if (version !== undefined && version !== "v2" && version !== "v2beta1") {
    throw new Error(
      `this is a dashboard.grafana.app/${version} dashboard; chant reads v2 and v2beta1. Read it from Grafana at dashboard.grafana.app/v2 and import that.`,
    );
  }
  const spec = version !== undefined ? obj(data.spec) : data;
  const meta = obj(data.metadata);
  const reader = new V2Reader(spec);
  const annotations = obj(meta.annotations);
  if (typeof annotations["grafana.app/folder"] === "string" && annotations["grafana.app/folder"] !== "") {
    reader.warn(`metadata: the folder "${String(annotations["grafana.app/folder"])}" is not carried (a dashboard's folder is set where it is provisioned)`);
  }
  const dashboard = reader.read(str(meta.name) ?? str(spec.uid));
  return { dashboard, warnings: reader.warnings };
}

/**
 * The version Grafana stores a dashboard at, when a `dashboard.grafana.app`
 * resource read at v0 or v1 says it is stored as v2 (`status.conversion`):
 * that read is a down-conversion that drops whatever v2 has and v1 does not
 * (tabs, auto grids, conditional rendering), with nothing in the spec to show
 * it. Also returns the stored version when the conversion failed. Undefined
 * for everything else.
 */
export function lossyV1Read(data: unknown): { apiVersion: string; storedVersion: string; failed: boolean } | undefined {
  if (!isObject(data)) return undefined;
  const version = resourceVersion(data);
  if (version === undefined || version.startsWith("v2")) return undefined;
  const conversion = obj(obj(data.status).conversion);
  const storedVersion = str(conversion.storedVersion) ?? "";
  const failed = conversion.failed === true;
  if (!storedVersion.startsWith("v2") && !failed) return undefined;
  return { apiVersion: String(data.apiVersion), storedVersion, failed };
}
