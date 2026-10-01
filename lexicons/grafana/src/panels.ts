/**
 * Panels and rows.
 *
 * Each built-in panel class is defined through `definePanel`, with its
 * `options` and `fieldConfig.defaults.custom` typed from that panel's
 * schema at `GRAFANA_SCHEMA_PIN`. Every option is optional: Grafana fills
 * in what a panel leaves out when it loads the dashboard. A panel plugin
 * chant doesn't ship (a community visualization, an in-house plugin) comes
 * in through `definePanel` too and is laid out, serialized and checked the
 * same way.
 *
 * `gridPos` is optional. A panel without `x` and `y` is placed by the
 * dashboard: left to right in declaration order, wrapping at Grafana's
 * 24-column width, below the previous row of panels, and around any cells
 * already taken. A panel with both is placed exactly there and reserves its
 * cells first; GRAF105 reports overlaps between explicit panels. A panel
 * with only `x` or only `y` keeps that column or line.
 */

import { createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { DeepPartial } from "./util";
import type { DatasourceInput, QueryEntity } from "./query";
import type { VariableEntity } from "./variables";
import type { SchemaName } from "./pin";
import type {
  DashboardLink,
  FieldConfig,
  FieldConfigSource,
  GridPos,
} from "./schema/dashboard.gen";
import type * as timeseries from "./schema/timeseries.gen";
import type * as stat from "./schema/stat.gen";
import type * as gauge from "./schema/gauge.gen";
import type * as table from "./schema/table.gen";
import type * as logs from "./schema/logs.gen";
import type * as heatmap from "./schema/heatmap.gen";
import type * as text from "./schema/text.gen";
import type * as barchart from "./schema/barchart.gen";
import type * as bargauge from "./schema/bargauge.gen";
import type * as piechart from "./schema/piechart.gen";
import type * as statetimeline from "./schema/statetimeline.gen";
import type * as statushistory from "./schema/statushistory.gen";
import type * as histogram from "./schema/histogram.gen";
import type * as nodegraph from "./schema/nodegraph.gen";
import type * as xychart from "./schema/xychart.gen";
import type * as trend from "./schema/trend.gen";
import type * as canvas from "./schema/canvas.gen";
import type * as geomap from "./schema/geomap.gen";
import type * as candlestick from "./schema/candlestick.gen";
import type * as annotationslist from "./schema/annotationslist.gen";
import type * as dashboardlist from "./schema/dashboardlist.gen";
import type * as news from "./schema/news.gen";
import type * as datagrid from "./schema/datagrid.gen";
import type { AlertListOptions, FlameGraphOptions } from "./panel-options";
import type { Transformation } from "./transformations";

/** `fieldConfig` with `defaults.custom` typed for the panel. */
export interface PanelFieldConfig<C> {
  defaults?: DeepPartial<Omit<FieldConfig, "custom">> & { custom?: DeepPartial<C> };
  overrides?: FieldConfigSource["overrides"];
}

/** A panel link: Grafana's `DashboardLink` fields, all but `title` optional. */
export type PanelLink = Partial<DashboardLink> & { title: string; url?: string };

export interface PanelProps<O = Record<string, unknown>, C = Record<string, unknown>> {
  title?: string;
  description?: string;
  /** Position and size in the 24-column grid. Leave out `x`/`y` to let the dashboard place it. */
  gridPos?: Partial<GridPos>;
  /** The datasource for every query that doesn't name its own. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasource?: DatasourceInput<any>;
  /** The panel's queries. `refId`s default to A, B, C… in order. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targets?: QueryEntity<any, any>[];
  /** The panel plugin's own options, typed from its schema. */
  options?: DeepPartial<O>;
  fieldConfig?: PanelFieldConfig<C>;
  /** Typed per transformer: `{ id: "organize", options: { ... } }`, `transformation(id, options)`, or `customTransformation()` for an id or option the types don't know. */
  transformations?: Transformation[];
  links?: PanelLink[];
  /** Repeat the panel once per value of this variable. */
  repeat?: VariableEntity | string;
  repeatDirection?: "h" | "v";
  maxPerRow?: number;
  maxDataPoints?: number;
  interval?: string;
  timeFrom?: string;
  timeShift?: string;
  hideTimeOverride?: boolean;
  transparent?: boolean;
  pluginVersion?: string;
  /** Panel id within the dashboard. Defaults to position order, 1, 2, 3… */
  id?: number;
}

export interface PanelDefinition<T extends string = string> {
  /** The panel plugin id Grafana stores in `type`. */
  type: T;
  className: string;
  description?: string;
  /** Size used when `gridPos` leaves `w` or `h` out. */
  defaultSize: { w: number; h: number };
  /** The vendored schema its options follow, when there is one (GRAF107 validates against it). */
  schema?: SchemaName;
  /** True only for the panels this package ships. */
  builtin: boolean;
}

export interface PanelEntity<O = Record<string, unknown>, C = Record<string, unknown>> extends Declarable {
  readonly props: PanelProps<O, C>;
  readonly panelDefinition: PanelDefinition;
}

export interface PanelClass<T extends string = string, O = Record<string, unknown>, C = Record<string, unknown>> {
  new (props?: PanelProps<O, C>): PanelEntity<O, C>;
  readonly definition: PanelDefinition<T>;
}

export const PANEL_TYPE_PREFIX = "Grafana::Panel::";
export const ROW_TYPE = "Grafana::Row";

const REGISTRY_KEY = Symbol.for("chant.grafana.panelDefinitions");
function registry(): Map<string, PanelDefinition> {
  const g = globalThis as unknown as Record<symbol, Map<string, PanelDefinition> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

/** Every registered panel definition, built-ins first. */
export function registeredPanels(): PanelDefinition[] {
  return [...registry().values()];
}

export function panelDefinitionFor(type: string): PanelDefinition | undefined {
  return registry().get(type);
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-_]*$/;
/** Core panel ids predate the lowercase rule plugin ids follow: the node graph is `nodeGraph`. */
const CORE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9-_]*$/;

function makePanelClass<T extends string, O, C>(def: PanelDefinition<T>): PanelClass<T, O, C> {
  if (!(def.builtin ? CORE_PLUGIN_ID : PLUGIN_ID).test(def.type)) throw new Error(`grafana: "${def.type}" is not a panel plugin id`);
  if (def.type === "row") throw new Error('grafana: "row" is not a panel; use Row');
  const existing = registry().get(def.type);
  if (existing?.builtin && !def.builtin) {
    throw new Error(`grafana: the "${def.type}" panel is built in (${existing.className}); use that class.`);
  }
  registry().set(def.type, def);
  const Base = createProperty(`${PANEL_TYPE_PREFIX}${def.type}`, "grafana") as unknown as (
    this: object,
    props: Record<string, unknown>,
  ) => void;
  const Cls = function (this: object, props?: Record<string, unknown>) {
    Base.call(this, props ?? {});
    Object.defineProperty(this, "panelDefinition", { value: def, enumerable: false });
  };
  Object.defineProperty(Cls, "name", { value: def.className });
  Object.defineProperty(Cls, "definition", { value: def, enumerable: false });
  return Cls as unknown as PanelClass<T, O, C>;
}

/**
 * Define a panel class for a panel plugin chant doesn't ship.
 *
 * @example
 * ```ts
 * interface ClockOptions { mode?: "time" | "countdown"; clockType?: "24 hour" | "12 hour" }
 *
 * export const ClockPanel = definePanel<ClockOptions>()({
 *   type: "grafana-clock-panel",
 *   className: "ClockPanel",
 *   defaultSize: { w: 6, h: 4 },
 * });
 * ```
 */
export function definePanel<O = Record<string, unknown>, C = Record<string, unknown>>() {
  return function <T extends string>(def: Omit<PanelDefinition<T>, "builtin">): PanelClass<T, O, C> {
    return makePanelClass<T, O, C>({ ...def, builtin: false });
  };
}

export function isPanelEntity(value: unknown): value is PanelEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === "grafana" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(PANEL_TYPE_PREFIX)
  );
}

// ── Built-in panels ─────────────────────────────────────────────

export const TimeSeriesPanel = makePanelClass<"timeseries", timeseries.Options, timeseries.FieldConfig>({
  type: "timeseries",
  className: "TimeSeriesPanel",
  description: "Time series: values over time as lines, bars or points",
  defaultSize: { w: 12, h: 8 },
  schema: "timeseries",
  builtin: true,
});

export const StatPanel = makePanelClass<"stat", stat.Options, Record<string, unknown>>({
  type: "stat",
  className: "StatPanel",
  description: "Stat: one big number per series, with an optional sparkline",
  defaultSize: { w: 6, h: 4 },
  schema: "stat",
  builtin: true,
});

export const GaugePanel = makePanelClass<"gauge", gauge.Options, Record<string, unknown>>({
  type: "gauge",
  className: "GaugePanel",
  description: "Gauge: a value against its min, max and thresholds",
  defaultSize: { w: 6, h: 6 },
  schema: "gauge",
  builtin: true,
});

export const TablePanel = makePanelClass<"table", table.Options, table.FieldConfig>({
  type: "table",
  className: "TablePanel",
  description: "Table: query results as rows and columns",
  defaultSize: { w: 12, h: 8 },
  schema: "table",
  builtin: true,
});

export const LogsPanel = makePanelClass<"logs", logs.Options, Record<string, unknown>>({
  type: "logs",
  className: "LogsPanel",
  description: "Logs: log lines from a logs datasource such as Loki",
  defaultSize: { w: 24, h: 10 },
  schema: "logs",
  builtin: true,
});

export const TracesPanel = makePanelClass<"traces", Record<string, unknown>, Record<string, unknown>>({
  type: "traces",
  className: "TracesPanel",
  description: "Traces: one trace as a span timeline, from a tracing datasource such as Tempo",
  defaultSize: { w: 24, h: 12 },
  builtin: true,
});

export const HeatmapPanel = makePanelClass<"heatmap", heatmap.Options, heatmap.FieldConfig>({
  type: "heatmap",
  className: "HeatmapPanel",
  description: "Heatmap: a distribution over time, e.g. histogram buckets",
  defaultSize: { w: 12, h: 8 },
  schema: "heatmap",
  builtin: true,
});

export const TextPanel = makePanelClass<"text", text.Options, Record<string, unknown>>({
  type: "text",
  className: "TextPanel",
  description: "Text: markdown or HTML, no queries",
  defaultSize: { w: 24, h: 3 },
  schema: "text",
  builtin: true,
});

export const BarChartPanel = makePanelClass<"barchart", barchart.Options, barchart.FieldConfig>({
  type: "barchart",
  className: "BarChartPanel",
  description: "Bar chart: categorical values as bars, grouped or stacked",
  defaultSize: { w: 12, h: 8 },
  schema: "barchart",
  builtin: true,
});

export const BarGaugePanel = makePanelClass<"bargauge", bargauge.Options, Record<string, unknown>>({
  type: "bargauge",
  className: "BarGaugePanel",
  description: "Bar gauge: one bar per series, filled against min, max and thresholds",
  defaultSize: { w: 12, h: 8 },
  schema: "bargauge",
  builtin: true,
});

export const PieChartPanel = makePanelClass<"piechart", piechart.Options, piechart.FieldConfig>({
  type: "piechart",
  className: "PieChartPanel",
  description: "Pie chart: each series' share of the total, as a pie or donut",
  defaultSize: { w: 8, h: 8 },
  schema: "piechart",
  builtin: true,
});

export const StateTimelinePanel = makePanelClass<"state-timeline", statetimeline.Options, statetimeline.FieldConfig>({
  type: "state-timeline",
  className: "StateTimelinePanel",
  description: "State timeline: state changes over time, one lane per series",
  defaultSize: { w: 24, h: 8 },
  schema: "statetimeline",
  builtin: true,
});

export const StatusHistoryPanel = makePanelClass<"status-history", statushistory.Options, statushistory.FieldConfig>({
  type: "status-history",
  className: "StatusHistoryPanel",
  description: "Status history: periodic states over time as a grid of cells",
  defaultSize: { w: 24, h: 8 },
  schema: "statushistory",
  builtin: true,
});

export const HistogramPanel = makePanelClass<"histogram", histogram.Options, histogram.FieldConfig>({
  type: "histogram",
  className: "HistogramPanel",
  description: "Histogram: the distribution of values, bucketed, over the whole time range",
  defaultSize: { w: 12, h: 8 },
  schema: "histogram",
  builtin: true,
});

export const NodeGraphPanel = makePanelClass<"nodeGraph", nodegraph.Options, Record<string, unknown>>({
  type: "nodeGraph",
  className: "NodeGraphPanel",
  description: "Node graph: a directed graph of nodes and edges, e.g. a service map",
  defaultSize: { w: 24, h: 12 },
  schema: "nodegraph",
  builtin: true,
});

export const XYChartPanel = makePanelClass<"xychart", xychart.Options, xychart.FieldConfig>({
  type: "xychart",
  className: "XYChartPanel",
  description: "XY chart: one field plotted against another, as points or lines",
  defaultSize: { w: 12, h: 8 },
  schema: "xychart",
  builtin: true,
});

export const TrendPanel = makePanelClass<"trend", trend.Options, trend.FieldConfig>({
  type: "trend",
  className: "TrendPanel",
  description: "Trend: values against a numeric x field that is not time",
  defaultSize: { w: 12, h: 8 },
  schema: "trend",
  builtin: true,
});

export const CanvasPanel = makePanelClass<"canvas", canvas.Options, Record<string, unknown>>({
  type: "canvas",
  className: "CanvasPanel",
  description: "Canvas: freely placed elements, text, icons and metrics bound to data",
  defaultSize: { w: 12, h: 10 },
  schema: "canvas",
  builtin: true,
});

export const GeomapPanel = makePanelClass<"geomap", geomap.Options, Record<string, unknown>>({
  type: "geomap",
  className: "GeomapPanel",
  description: "Geomap: data on a world map, as markers, heatmaps or routes",
  defaultSize: { w: 12, h: 10 },
  schema: "geomap",
  builtin: true,
});

export const CandlestickPanel = makePanelClass<"candlestick", candlestick.Options, candlestick.FieldConfig>({
  type: "candlestick",
  className: "CandlestickPanel",
  description: "Candlestick: open, high, low and close values over time, as candles or OHLC bars",
  defaultSize: { w: 12, h: 8 },
  schema: "candlestick",
  builtin: true,
});

export const AnnotationsListPanel = makePanelClass<"annolist", annotationslist.Options, Record<string, unknown>>({
  type: "annolist",
  className: "AnnotationsListPanel",
  description: "Annotations list: recent annotations, filterable by dashboard, time range and tag, no queries",
  defaultSize: { w: 8, h: 10 },
  schema: "annotationslist",
  builtin: true,
});

export const DashboardListPanel = makePanelClass<"dashlist", dashboardlist.Options, Record<string, unknown>>({
  type: "dashlist",
  className: "DashboardListPanel",
  description: "Dashboard list: starred, recent or searched dashboards as links, no queries",
  defaultSize: { w: 8, h: 10 },
  schema: "dashboardlist",
  builtin: true,
});

export const NewsPanel = makePanelClass<"news", news.Options, Record<string, unknown>>({
  type: "news",
  className: "NewsPanel",
  description: "News: items from an RSS or Atom feed, no queries",
  defaultSize: { w: 8, h: 10 },
  schema: "news",
  builtin: true,
});

export const DataGridPanel = makePanelClass<"datagrid", datagrid.Options, Record<string, unknown>>({
  type: "datagrid",
  className: "DataGridPanel",
  description: "Data grid: an editable table of a series' values (experimental in Grafana)",
  defaultSize: { w: 12, h: 8 },
  schema: "datagrid",
  builtin: true,
});

export const FlameGraphPanel = makePanelClass<"flamegraph", FlameGraphOptions, Record<string, unknown>>({
  type: "flamegraph",
  className: "FlameGraphPanel",
  description: "Flame graph: profiling data, e.g. from Pyroscope, as a flame graph and table",
  defaultSize: { w: 24, h: 12 },
  builtin: true,
});

export const AlertListPanel = makePanelClass<"alertlist", AlertListOptions, Record<string, unknown>>({
  type: "alertlist",
  className: "AlertListPanel",
  description: "Alert list: alert rules and their current state, no queries",
  defaultSize: { w: 8, h: 10 },
  builtin: true,
});

// ── Rows ────────────────────────────────────────────────────────

export interface RowProps {
  title: string;
  /** Collapsed rows keep their panels inside the row until opened. */
  collapsed?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panels?: PanelEntity<any, any>[];
  /** Repeat the row once per value of this variable. */
  repeat?: VariableEntity | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasource?: DatasourceInput<any>;
  id?: number;
  /**
   * The grid line the row header sits on. Without it, the row goes on the
   * first free line below everything declared before it. A row header is
   * always full width and one line high, so `y` is all it takes.
   */
  gridPos?: { y: number };
}

export interface RowEntity extends Declarable {
  readonly props: RowProps;
}

const RowBase = createProperty(ROW_TYPE, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;

/** A full-width row header; the panels listed in it are placed below it. */
export const Row = function (this: object, props: RowProps) {
  RowBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: RowProps) => RowEntity;
Object.defineProperty(Row, "name", { value: "Row" });

export function isRowEntity(value: unknown): value is RowEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === ROW_TYPE && (value as Declarable).lexicon === "grafana";
}
