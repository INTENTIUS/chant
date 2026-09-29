/**
 * What each piece of classic dashboard JSON becomes: the tables the
 * importer's parser reads. They are the extension points for the issues
 * that teach the importer more of Grafana.
 *
 * - Panel types (#2950): a built-in panel class is found in the panel
 *   registry (`registeredPanels()`), so a class added with `builtin: true`
 *   in `panels.ts` is used by the importer with no change here. Any other
 *   type is declared in the imported source with `definePanel`.
 * - Query types (#2951): the same, through `registeredQueries()`, keyed by
 *   datasource plugin type; any other type gets a `defineQuery`.
 * - Variable types (#2952): `VARIABLE_MAPPINGS` has one entry per type the
 *   lexicon has a class for. A type with no entry (`system`, `snapshot`,
 *   which Grafana does not save) is reported and left out.
 * - Dashboard and panel fields (#2953 annotations, and any new prop):
 *   `DASHBOARD_FIELDS`, `PANEL_FIELDS` and `ROW_FIELDS` list the JSON keys
 *   copied onto a prop as they are. A key in none of the tables, and not
 *   handled by the parser, is reported and left out, unless it is at the
 *   value Grafana assumes when it is missing (see `./normalize.ts`).
 */

import { registeredPanels, type PanelDefinition } from "../panels";
import { registeredQueries, type QueryDefinition } from "../query";
import type { VariableHide } from "../variables";
import { deepEqual, splitValues } from "./normalize";

type Json = Record<string, unknown>;

/** Dashboard JSON keys carried onto the `Dashboard` prop of the same name, as they are. */
export const DASHBOARD_FIELDS: readonly string[] = [
  "title",
  "uid",
  "description",
  "tags",
  "time",
  "refresh",
  "timezone",
  "weekStart",
  "fiscalYearStartMonth",
  "liveNow",
  "timepicker",
  "editable",
  "links",
];

/** Panel JSON keys carried onto the panel prop of the same name, as they are. */
export const PANEL_FIELDS: readonly string[] = [
  "id",
  "title",
  "description",
  "gridPos",
  "options",
  "fieldConfig",
  "transformations",
  "links",
  "repeatDirection",
  "maxPerRow",
  "maxDataPoints",
  "interval",
  "timeFrom",
  "timeShift",
  "hideTimeOverride",
  "transparent",
  "pluginVersion",
];

/**
 * Row JSON keys carried onto the `Row` prop of the same name. A row's
 * `gridPos` is not among them: the build places a row below what comes
 * before it, which is where Grafana keeps it.
 */
export const ROW_FIELDS: readonly string[] = ["id", "title", "collapsed"];

/** `graphTooltip` as Grafana stores it, and as `Dashboard` takes it. */
export const GRAPH_TOOLTIP: Readonly<Record<number, "default" | "sharedCrosshair" | "sharedTooltip">> = {
  0: "default",
  1: "sharedCrosshair",
  2: "sharedTooltip",
};

/** A variable's `hide` as Grafana stores it, and as the variable classes take it. */
export const VARIABLE_HIDE: Readonly<Record<number, VariableHide>> = { 0: "label", 1: "valueOnly", 2: "hidden" };

/** A query variable's `refresh` as Grafana stores it, and as `QueryVariable` takes it. */
export const QUERY_REFRESH: Readonly<Record<number, "never" | "onLoad" | "onTimeRangeChange">> = {
  0: "never",
  1: "onLoad",
  2: "onTimeRangeChange",
};

/** The class a panel of this plugin type is declared with, when chant ships one. */
export function builtinPanelFor(type: string): PanelDefinition | undefined {
  return registeredPanels().find((d) => d.builtin && d.type === type);
}

/** The class a query to a datasource of this plugin type is declared with, when chant ships one. */
export function builtinQueryFor(datasourceType: string): QueryDefinition | undefined {
  return registeredQueries().find((d) => d.builtin && d.datasourceType === datasourceType);
}

/**
 * The datasource type a query with no datasource of its own, on a panel
 * with none, is declared under. Grafana sends it to the default datasource;
 * the class exists only to hold the query model.
 */
export const DEFAULT_DATASOURCE_TYPE = "default";

/** What converting one variable needs from the rest of the import. */
export interface VariableContext {
  /** The variable's JSON. */
  readonly json: Json;
  /** Its JSON pointer, for edits. */
  readonly path: string;
  /** Resolve a `datasource` value to a prop value, reporting what cannot be resolved. */
  datasource(value: unknown, path: string): unknown;
  /** Report a key that is not carried; `why` is the end of the sentence, after "not carried". */
  drop(key: string, why?: string): void;
  /** Report the whole variable as not carried. */
  dropVariable(why: string): void;
  /** Record that `key` is written differently but means the same, or with the given warning. */
  replace(key: string, value: unknown, why?: string): void;
}

/** One variable type the lexicon has a class for: which class, and how its JSON becomes props. */
export interface VariableMapping {
  readonly className: string;
  /** JSON keys the mapping reads, whether it carries them or derives them. Any other key is reported. */
  readonly keys: readonly string[];
  /** The type-specific props, or undefined when the variable cannot be carried (after `ctx.dropVariable`). */
  convert(ctx: VariableContext): Json | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "" || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Split a custom or interval variable's `query` the way Grafana does: on commas not escaped as `\\,`, trimmed. */
export const valuesOf = splitValues;

function multiValue(json: Json): Json {
  const out: Json = {};
  if (json.multi === true) out.multi = true;
  if (json.includeAll === true) out.includeAll = true;
  if (nonEmpty(json.allValue)) out.allValue = json.allValue;
  return out;
}

function current(json: Json): Json {
  return nonEmpty(json.current) ? { current: json.current } : {};
}

const MULTI_KEYS = ["multi", "includeAll", "allValue"];

/** Per Grafana variable type, the class and props it becomes. */
export const VARIABLE_MAPPINGS: Readonly<Record<string, VariableMapping>> = {
  query: {
    className: "QueryVariable",
    keys: ["datasource", "query", "definition", "regex", "refresh", "sort", "options", "current", ...MULTI_KEYS],
    convert(ctx) {
      const { json } = ctx;
      // The object form (Prometheus writes `{ qryType, query, refId }`) is carried as it is: the datasource reads all of it.
      const query: string | Json = json.query !== null && typeof json.query === "object" && !Array.isArray(json.query) ? (json.query as Json) : (str(json.query) ?? "");
      const text = typeof query === "string" ? query : str(query.query);
      const refresh = typeof json.refresh === "number" ? json.refresh : 1;
      if (refresh === 0 && nonEmpty(json.options)) {
        ctx.drop("options", "(QueryVariable does not store options; with refresh never, Grafana shows none until it is refreshed)");
      }
      const out: Json = { datasource: ctx.datasource(json.datasource, `${ctx.path}/datasource`), query };
      if (nonEmpty(json.definition) && json.definition !== text) out.definition = json.definition;
      if (out.datasource === undefined) {
        ctx.dropVariable("it has no datasource chant can refer to, and QueryVariable needs one");
        return undefined;
      }
      if (nonEmpty(json.regex)) out.regex = json.regex;
      if (refresh !== 1 && QUERY_REFRESH[refresh]) out.refresh = QUERY_REFRESH[refresh];
      if (typeof json.sort === "number" && json.sort !== 0) out.sort = json.sort;
      return { ...out, ...multiValue(json), ...current(json) };
    },
  },
  custom: {
    className: "CustomVariable",
    keys: ["query", "options", "current", ...MULTI_KEYS],
    convert(ctx) {
      const { json } = ctx;
      return { values: valuesOf(str(json.query) ?? ""), ...multiValue(json), ...current(json) };
    },
  },
  interval: {
    className: "IntervalVariable",
    keys: ["query", "options", "current", "refresh", "auto", "auto_count", "auto_min"],
    convert(ctx) {
      const { json } = ctx;
      const out: Json = { values: valuesOf(str(json.query) ?? "") };
      if (json.auto === true) out.auto = true;
      if (typeof json.auto_count === "number" && json.auto_count !== 30) out.autoCount = json.auto_count;
      if (typeof json.auto_min === "string" && json.auto_min !== "10s") out.autoMin = json.auto_min;
      return { ...out, ...current(json) };
    },
  },
  datasource: {
    className: "DatasourceVariable",
    keys: ["query", "regex", "refresh", "options", "current", ...MULTI_KEYS],
    convert(ctx) {
      const { json } = ctx;
      const pluginType = str(json.query);
      if (!pluginType) {
        ctx.dropVariable("it names no datasource plugin type");
        return undefined;
      }
      const out: Json = { pluginType };
      if (nonEmpty(json.regex)) out.regex = json.regex;
      return { ...out, ...multiValue(json), ...current(json) };
    },
  },
  constant: {
    className: "ConstantVariable",
    keys: ["query", "options", "current", "hide"],
    convert(ctx) {
      const { json } = ctx;
      if (json.hide !== undefined && json.hide !== 2) {
        ctx.replace("hide", 2, "is not 2: chant always writes a constant hidden, as Grafana shows it");
      }
      return { value: str(json.query) ?? "" };
    },
  },
  textbox: {
    className: "TextboxVariable",
    keys: ["query", "options", "current"],
    convert(ctx) {
      const { json } = ctx;
      const value = str(json.query) ?? "";
      const cur = json.current as Json | undefined;
      if (nonEmpty(cur) && cur!.value !== value) {
        ctx.drop("current", `(the box's value "${String(cur!.value)}"; TextboxVariable starts at its default, "${value}")`);
      }
      return value === "" ? {} : { value };
    },
  },
  adhoc: {
    className: "AdhocVariable",
    keys: ["datasource", "filters", "baseFilters", "defaultKeys", "allowCustomValue", "enableGroupBy", "current", "options"],
    convert(ctx) {
      const { json } = ctx;
      const out: Json = { datasource: ctx.datasource(json.datasource, `${ctx.path}/datasource`) };
      if (out.datasource === undefined) {
        ctx.dropVariable("it has no datasource chant can refer to, and AdhocVariable needs one");
        return undefined;
      }
      if (filters(json.filters)) out.filters = json.filters;
      if (filters(json.baseFilters)) out.baseFilters = json.baseFilters;
      if (Array.isArray(json.defaultKeys)) out.defaultKeys = json.defaultKeys;
      if (json.allowCustomValue === false) out.allowCustomValue = false;
      if (json.enableGroupBy === true) out.enableGroupBy = true;
      return out;
    },
  },
  groupby: {
    className: "GroupByVariable",
    keys: ["datasource", "options", "current", "defaultValue", "allowCustomValue"],
    convert(ctx) {
      const { json } = ctx;
      const out: Json = { datasource: ctx.datasource(json.datasource, `${ctx.path}/datasource`) };
      if (out.datasource === undefined) {
        ctx.dropVariable("it has no datasource chant can refer to, and GroupByVariable needs one");
        return undefined;
      }
      if (Array.isArray(json.options) && json.options.length > 0) out.options = json.options.map(keyOption);
      const def = json.defaultValue as Json | undefined;
      if (nonEmpty(def)) out.defaultValue = Array.isArray(def!.value) && deepEqual(def!.text, def!.value) ? def!.value : def;
      // The build writes the default as the current selection when there is no other.
      if (nonEmpty(json.current) && !deepEqual(json.current, def)) out.current = json.current;
      if (json.allowCustomValue === false) out.allowCustomValue = false;
      return out;
    },
  },
  switch: {
    className: "SwitchVariable",
    keys: ["current", "options"],
    convert(ctx) {
      const { json } = ctx;
      const options = Array.isArray(json.options) ? json.options : [];
      // Grafana keeps the enabled value first and the disabled value second.
      const on = firstValue(options[0]) ?? "true";
      const off = firstValue(options[1]) ?? "false";
      const out: Json = {};
      if (on !== "true") out.enabledValue = on;
      if (off !== "false") out.disabledValue = off;
      const value = firstValue(json.current);
      if (value === on) out.enabled = true;
      else if (value !== off) {
        ctx.replace("current", { text: off, value: off }, `is ${value === undefined ? "missing" : `"${value}", neither the enabled nor the disabled value`}; the switch starts off`);
      }
      return out;
    },
  },
};

/** An ad hoc filter list, or undefined when it is empty (the build writes `[]`). */
function filters(v: unknown): unknown[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

/** A `{ text, value }` option as the shortest prop that builds back to it: the value when the text is the same. */
function keyOption(o: unknown): unknown {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const { text, value, ...rest } = o as Json;
    if (Object.keys(rest).length === 0 && typeof value === "string" && text === value) return value;
  }
  return o;
}

/** The first value of a `VariableOption`'s value, which may be a list. */
function firstValue(o: unknown): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Json).value;
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}

/** Keys every variable type reads: the ones `CommonVariableProps` has, and `type`. */
export const COMMON_VARIABLE_KEYS: readonly string[] = ["type", "name", "label", "description", "hide", "skipUrlSync"];
