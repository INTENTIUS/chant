/**
 * Dashboard variables (Grafana's "templating"): query, custom, interval,
 * datasource, constant, textbox, ad hoc filters, group by and switch.
 *
 * A variable is declared on its own and listed in a dashboard's
 * `variables`. Queries reference it as `$name` or `${name}` in their
 * expression; GRAF103 checks every such reference names a declared
 * variable. A `DatasourceVariable` can stand in for a datasource on a panel
 * or query, and the reference becomes `${name}`.
 */

import { createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { DatasourceEntity, DatasourceRef, ExternalDatasourceEntity } from "./datasource";
import type { AdHocFilter, VariableOption } from "./schema/dashboard.gen";

export type VariableKind = "query" | "custom" | "interval" | "datasource" | "constant" | "textbox" | "adhoc" | "groupby" | "switch";

/** The kinds Grafana can repeat a panel or row over: the ones that hold a list of values (`MultiValueVariable` in @grafana/scenes). */
export const MULTI_VALUE_KINDS: ReadonlySet<string> = new Set(["query", "custom", "datasource", "groupby"]);

/** Where the variable shows: with its label, without it, or not at all. */
export type VariableHide = "label" | "valueOnly" | "hidden";

interface CommonVariableProps {
  /** The name queries use, `$name`. Letters, digits and `_`. */
  name: string;
  label?: string;
  description?: string;
  hide?: VariableHide;
  /** Keep the value out of the URL. */
  skipUrlSync?: boolean;
  /** The value selected when the dashboard loads. */
  current?: VariableOption;
}

interface MultiValueProps {
  multi?: boolean;
  includeAll?: boolean;
  /** What `All` expands to, e.g. `.*` for a regex matcher. */
  allValue?: string;
}

/** A variable anything can hold before its datasource is known: its own datasource ref or a datasource variable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariableDatasource = DatasourceEntity<any> | ExternalDatasourceEntity<any> | DatasourceRef | DatasourceVariableEntity<any>;

/**
 * A variable query in the object form a datasource's variable editor
 * writes. Grafana passes it to the datasource as it is, so any key the
 * datasource reads may be here.
 */
export interface VariableQueryObject {
  /** The query text, when the datasource has one (Prometheus, Loki, and most others). */
  query?: string;
  /** The editor's id for the query; Grafana writes e.g. `PrometheusVariableQueryEditor-VariableQuery`. */
  refId?: string;
  [key: string]: unknown;
}

/**
 * A Prometheus variable query as Grafana's Prometheus variable editor
 * writes it. `query` is the text Grafana runs (`label_values(up, job)`);
 * the other fields let the editor show the query in its form again.
 */
export interface PrometheusVariableQuery extends VariableQueryObject {
  query: string;
  /** The editor's query type: 0 label names, 1 label values, 2 metrics, 3 query result, 4 series query, 5 classic query. */
  qryType?: 0 | 1 | 2 | 3 | 4 | 5;
  label?: string;
  metric?: string;
  seriesQuery?: string;
  varQueryResult?: string;
  labelFilters?: Array<{ label: string; op: string; value: string }>;
}

export interface QueryVariableProps extends CommonVariableProps, MultiValueProps {
  datasource: VariableDatasource;
  /**
   * The datasource's variable query: a string (`label_values(up, job)` for
   * Prometheus), or the object the datasource's variable editor writes
   * (`{ query: "label_values(up, job)", qryType: 1 }`).
   */
  query: string | VariableQueryObject;
  /** The text Grafana shows for the query in the variable list. Defaults to the query string. */
  definition?: string;
  regex?: string;
  /** When to re-run the query. Defaults to on dashboard load. */
  refresh?: "never" | "onLoad" | "onTimeRangeChange";
  /** Grafana's `VariableSort` (0 disabled, 1 alphabetical asc, 2 desc, 3 numerical asc, …). */
  sort?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export interface CustomVariableProps extends CommonVariableProps, MultiValueProps {
  /**
   * The values, in Grafana's syntax: `"Production : prod"` shows
   * `Production` and sets `prod`. A comma is part of the value (written as
   * `\,`, and one already escaped is kept).
   */
  values: string[];
}

export interface IntervalVariableProps extends CommonVariableProps {
  /** e.g. `["1m", "5m", "1h"]`. */
  values: string[];
  auto?: boolean;
  autoCount?: number;
  autoMin?: string;
}

export interface DatasourceVariableProps<T extends string = string> extends CommonVariableProps, MultiValueProps {
  /** The datasource plugin id to choose among, e.g. `prometheus`. */
  pluginType: T;
  /** Only datasources whose name matches. */
  regex?: string;
}

export interface ConstantVariableProps extends Omit<CommonVariableProps, "hide"> {
  value: string;
}

export interface TextboxVariableProps extends CommonVariableProps {
  value?: string;
}

/** One ad hoc filter: `key operator value`, e.g. `{ key: "namespace", operator: "=", value: "shop" }`. */
export type AdhocFilter = AdHocFilter;

/** A key an ad hoc or group by variable offers, in place of asking the datasource. */
export interface VariableKeyOption {
  text: string;
  value?: string | number;
  [key: string]: unknown;
}

export interface AdhocVariableProps extends CommonVariableProps {
  /** The datasource whose queries get the filters, and which is asked for keys and values. */
  datasource: VariableDatasource;
  /** The filters applied when the dashboard loads. */
  filters?: AdhocFilter[];
  /** Filters that narrow the key and value lookups, not shown or applied to queries. */
  baseFilters?: AdhocFilter[];
  /** A fixed set of keys to offer instead of the datasource's. */
  defaultKeys?: VariableKeyOption[];
  /** Whether a key or value not in the list can be typed in. Grafana's default is true. */
  allowCustomValue?: boolean;
  /** Offer the group-by operator in the filter box (Grafana 13, behind the `dashboardUnifiedDrilldownControls` feature toggle). */
  enableGroupBy?: boolean;
}

export interface GroupByVariableProps extends CommonVariableProps {
  /** The datasource whose queries are grouped, and which is asked for the keys. */
  datasource: VariableDatasource;
  /** A fixed set of keys to offer instead of the datasource's: a key, or `{ text, value }`. */
  options?: Array<string | { text: string; value: string }>;
  /** The keys selected when the dashboard loads with none in the URL. */
  defaultValue?: string[] | VariableOption;
  /** Whether a key not in the list can be typed in. Grafana's default is true. */
  allowCustomValue?: boolean;
}

export interface SwitchVariableProps extends Omit<CommonVariableProps, "current"> {
  /** Whether the switch is on when the dashboard loads. Defaults to off. */
  enabled?: boolean;
  /** The value `$name` has when the switch is on. Defaults to `"true"`. */
  enabledValue?: string;
  /** The value `$name` has when the switch is off. Defaults to `"false"`. */
  disabledValue?: string;
}

export interface VariableEntity<P = CommonVariableProps> extends Declarable {
  readonly props: P;
  readonly variableKind: VariableKind;
  /** The variable name, `$name` in queries. */
  readonly variableName: string;
}

export interface DatasourceVariableEntity<T extends string = string> extends VariableEntity<DatasourceVariableProps<T>> {
  readonly variableKind: "datasource";
  readonly pluginType: T;
}

export const VARIABLE_TYPE_PREFIX = "Grafana::Variable::";

function variableClass<P extends CommonVariableProps | ConstantVariableProps | SwitchVariableProps>(kind: VariableKind, className: string) {
  const Base = createProperty(`${VARIABLE_TYPE_PREFIX}${kind}`, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props: P) {
    Base.call(this, props as unknown as Record<string, unknown>);
    Object.defineProperty(this, "variableKind", { value: kind, enumerable: false });
    Object.defineProperty(this, "variableName", { value: props.name, enumerable: false });
    if (kind === "datasource") {
      Object.defineProperty(this, "pluginType", { value: (props as unknown as DatasourceVariableProps).pluginType, enumerable: false });
    }
  };
  Object.defineProperty(Cls, "name", { value: className });
  return Cls;
}

/** A variable whose values come from a datasource query. */
export const QueryVariable = variableClass<QueryVariableProps>("query", "QueryVariable") as unknown as new (
  props: QueryVariableProps,
) => VariableEntity<QueryVariableProps>;

/** A variable with a fixed list of values. */
export const CustomVariable = variableClass<CustomVariableProps>("custom", "CustomVariable") as unknown as new (
  props: CustomVariableProps,
) => VariableEntity<CustomVariableProps>;

/** A time interval to choose, used as `$name` in range selectors. */
export const IntervalVariable = variableClass<IntervalVariableProps>("interval", "IntervalVariable") as unknown as new (
  props: IntervalVariableProps,
) => VariableEntity<IntervalVariableProps>;

/** A choice of datasource of one plugin type. Usable wherever a datasource is. */
export const DatasourceVariable = variableClass<DatasourceVariableProps>("datasource", "DatasourceVariable") as unknown as {
  new <T extends string>(props: DatasourceVariableProps<T>): DatasourceVariableEntity<T>;
};

/** A hidden, fixed value. */
export const ConstantVariable = variableClass<ConstantVariableProps>("constant", "ConstantVariable") as unknown as new (
  props: ConstantVariableProps,
) => VariableEntity<ConstantVariableProps>;

/** A free-text box. */
export const TextboxVariable = variableClass<TextboxVariableProps>("textbox", "TextboxVariable") as unknown as new (
  props: TextboxVariableProps,
) => VariableEntity<TextboxVariableProps>;

/**
 * Ad hoc filters: `key operator value` filters Grafana adds to every query
 * sent to the variable's datasource (Prometheus, Loki, Elasticsearch,
 * InfluxDB and others whose plugin supports them). Referenced by no query.
 */
export const AdhocVariable = variableClass<AdhocVariableProps>("adhoc", "AdhocVariable") as unknown as new (
  props: AdhocVariableProps,
) => VariableEntity<AdhocVariableProps>;

/**
 * Group by: a choice of label keys Grafana adds as a grouping to every query
 * sent to the variable's datasource. In Grafana 12.4 and 13.x it is
 * experimental: with the `groupByVariable` feature toggle off, Grafana
 * drops it when the dashboard loads.
 */
export const GroupByVariable = variableClass<GroupByVariableProps>("groupby", "GroupByVariable") as unknown as new (
  props: GroupByVariableProps,
) => VariableEntity<GroupByVariableProps>;

/** An on/off switch, `$name` being `enabledValue` or `disabledValue`. New in Grafana 12.3. */
export const SwitchVariable = variableClass<SwitchVariableProps>("switch", "SwitchVariable") as unknown as new (
  props: SwitchVariableProps,
) => VariableEntity<SwitchVariableProps>;

export function isVariableEntity(value: unknown): value is VariableEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === "grafana" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(VARIABLE_TYPE_PREFIX)
  );
}

export function isDatasourceVariable(value: unknown): value is DatasourceVariableEntity {
  return isVariableEntity(value) && value.variableKind === "datasource";
}

/** Variable names Grafana defines itself; queries may use them without declaring anything. */
export function isBuiltinVariable(name: string): boolean {
  return name.startsWith("__") || name === "timeFilter" || name === "interval" || name === "interval_ms";
}

/** A valid variable name: what `$name` can match. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
