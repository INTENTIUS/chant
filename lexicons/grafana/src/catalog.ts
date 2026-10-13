/**
 * The built-in entity catalog: every class this package exports, keyed by
 * class name. It feeds the packaged registry (`dist/meta.json`), LSP
 * completions and hover, and the docs.
 */

import type { LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { DATASOURCE_PROVISIONING_TYPE, DATASOURCE_TYPE, EXTERNAL_DATASOURCE_TYPE } from "./datasource";
import { FOLDER_TYPE } from "./folder";
import { LIBRARY_PANEL_REF_TYPE, LIBRARY_PANEL_TYPE } from "./library-panel";
import { DASHBOARD_TYPE, DASHBOARD_PROVIDER_TYPE } from "./dashboard";
import * as panels from "./panels";
import * as queries from "./query";
import { VARIABLE_TYPE_PREFIX } from "./variables";
import {
  ALERT_QUERY_TYPE,
  ALERT_RULE_GROUP_TYPE,
  ALERT_RULE_TYPE,
  CONTACT_POINT_TYPE,
  EXPRESSION_TYPE_PREFIX,
  MUTE_TIMING_TYPE,
  NOTIFICATION_POLICY_TYPE,
  NOTIFICATION_TEMPLATE_TYPE,
} from "./alerting";

export type CatalogKind = "dashboard" | "folder" | "datasource" | "provider" | "panel" | "library" | "row" | "query" | "variable" | "alerting" | "expression";

export interface CatalogEntry {
  className: string;
  entityType: string;
  kind: CatalogKind;
  /** Resource entities are emitted; property entities live inside one. */
  entityKind: "resource" | "property";
  /** The Grafana plugin id, for panels and queries. */
  pluginId?: string;
  description: string;
}

function isClassWith<T>(v: unknown, key: string): v is { definition: T } {
  return typeof v === "function" && typeof (v as unknown as Record<string, unknown>)[key] === "object";
}

const panelEntries: CatalogEntry[] = (Object.entries(panels) as Array<[string, unknown]>)
  .filter((e): e is [string, panels.PanelClass] => isClassWith<panels.PanelDefinition>(e[1], "definition"))
  .map(([className, cls]) => ({
    className,
    entityType: `${panels.PANEL_TYPE_PREFIX}${cls.definition.type}`,
    kind: "panel",
    entityKind: "property",
    pluginId: cls.definition.type,
    description: cls.definition.description ?? "",
  }));

const queryEntries: CatalogEntry[] = (Object.entries(queries) as Array<[string, unknown]>)
  .filter((e): e is [string, queries.QueryClass] => isClassWith<queries.QueryDefinition>(e[1], "definition"))
  .map(([className, cls]) => ({
    className,
    entityType: `${queries.QUERY_TYPE_PREFIX}${cls.definition.datasourceType}`,
    kind: "query",
    entityKind: "property",
    pluginId: cls.definition.datasourceType,
    description: cls.definition.description ?? "",
  }));

const VARIABLES: Array<[string, string, string]> = [
  ["QueryVariable", "query", "A variable whose values come from a datasource query"],
  ["CustomVariable", "custom", "A variable with a fixed list of values"],
  ["IntervalVariable", "interval", "A time interval to choose, for range selectors"],
  ["DatasourceVariable", "datasource", "A choice of datasource of one plugin type; usable wherever a datasource is"],
  ["ConstantVariable", "constant", "A hidden, fixed value"],
  ["TextboxVariable", "textbox", "A free-text box"],
  ["AdhocVariable", "adhoc", "Key/value filters Grafana adds to every query sent to the variable's datasource"],
  ["GroupByVariable", "groupby", "A choice of label keys Grafana groups every query to the variable's datasource by (experimental in Grafana)"],
  ["SwitchVariable", "switch", "An on/off switch with a value for each state (Grafana 12.3 and later)"],
];

const EXPRESSIONS: Array<[string, string, string]> = [
  ["ReduceExpression", "reduce", "A server-side expression reducing each series to one number (last, mean, max, ...)"],
  ["MathExpression", "math", "A server-side math expression over other results by refId, e.g. $A / $B"],
  ["ThresholdExpression", "threshold", "A server-side threshold, with an optional recovery threshold"],
  ["ResampleExpression", "resample", "A server-side expression resampling a time series to a fixed window"],
  ["ClassicConditionsExpression", "classic_conditions", "Grafana's legacy classic conditions, as a server-side expression"],
  ["SqlExpression", "sql", "A server-side SQL expression over the other results"],
];

export const BUILTIN_CATALOG: CatalogEntry[] = [
  {
    className: "Dashboard",
    entityType: DASHBOARD_TYPE,
    kind: "dashboard",
    entityKind: "resource",
    description: "A dashboard: title, uid, time range, variables, rows, panels and links, written as the JSON Grafana imports",
  },
  {
    className: "Datasource",
    entityType: DATASOURCE_TYPE,
    kind: "datasource",
    entityKind: "resource",
    description: "A datasource, declared once and referenced by panels, queries and variables",
  },
  {
    className: "ExternalDatasource",
    entityType: EXTERNAL_DATASOURCE_TYPE,
    kind: "datasource",
    entityKind: "resource",
    description: "A datasource that already exists in Grafana: referenced like a Datasource and checked by GRAF101/GRAF102, never provisioned",
  },
  {
    className: "Folder",
    entityType: FOLDER_TYPE,
    kind: "folder",
    entityKind: "resource",
    description: "A folder with a stable uid, nested with parent; a dashboard's folder may be one instead of a path",
  },
  {
    className: "LibraryPanel",
    entityType: LIBRARY_PANEL_TYPE,
    kind: "library",
    entityKind: "resource",
    description: "A panel kept in Grafana's library and shared by dashboards; the build writes it into their __elements, and the API applier into the library",
  },
  {
    className: "DatasourceProvisioning",
    entityType: DATASOURCE_PROVISIONING_TYPE,
    kind: "provider",
    entityKind: "resource",
    description: "The datasource provisioning file's prune (on by default) and deleteDatasources",
  },
  {
    className: "DashboardProvider",
    entityType: DASHBOARD_PROVIDER_TYPE,
    kind: "provider",
    entityKind: "resource",
    description: "An entry in the dashboard provisioning file; a default one is written when none is declared",
  },
  {
    className: "Row",
    entityType: panels.ROW_TYPE,
    kind: "row",
    entityKind: "property",
    description: "A full-width row header; its panels are placed below it, or inside it when collapsed",
  },
  {
    className: "LibraryPanelRef",
    entityType: LIBRARY_PANEL_REF_TYPE,
    kind: "library",
    entityKind: "property",
    description: "A library panel placed on a dashboard, with its own gridPos, id and title; names a LibraryPanel, or { uid, name } of one already in Grafana",
  },
  {
    className: "AlertRuleGroup",
    entityType: ALERT_RULE_GROUP_TYPE,
    kind: "alerting",
    entityKind: "resource",
    description: "A group of Grafana-managed alert and recording rules in a folder, evaluated together at one interval",
  },
  {
    className: "ContactPoint",
    entityType: CONTACT_POINT_TYPE,
    kind: "alerting",
    entityKind: "resource",
    description: "A contact point: the integrations (email, Slack, webhook, ...) alerts are sent to, under one name",
  },
  {
    className: "NotificationPolicy",
    entityType: NOTIFICATION_POLICY_TYPE,
    kind: "alerting",
    entityKind: "resource",
    description: "An organisation's notification policy tree: the root receiver and the routes that match alerts to contact points",
  },
  {
    className: "MuteTiming",
    entityType: MUTE_TIMING_TYPE,
    kind: "alerting",
    entityKind: "resource",
    description: "A named time interval that mutes (or, as active_time_intervals, enables) notifications",
  },
  {
    className: "NotificationTemplate",
    entityType: NOTIFICATION_TEMPLATE_TYPE,
    kind: "alerting",
    entityKind: "resource",
    description: "A notification template group, Go templates contact point settings can use",
  },
  {
    className: "AlertRule",
    entityType: ALERT_RULE_TYPE,
    kind: "alerting",
    entityKind: "property",
    description: "A Grafana-managed alert or recording rule: queries, expressions and the condition that fires it",
  },
  {
    className: "AlertQuery",
    entityType: ALERT_QUERY_TYPE,
    kind: "alerting",
    entityKind: "property",
    description: "A datasource query of an alert rule, with its model as Grafana stores it and its time range",
  },
  ...EXPRESSIONS.map(
    ([className, type, description]): CatalogEntry => ({
      className,
      entityType: `${EXPRESSION_TYPE_PREFIX}${type}`,
      kind: "expression",
      entityKind: "property",
      description,
    }),
  ),
  ...panelEntries,
  ...queryEntries,
  ...VARIABLES.map(
    ([className, type, description]): CatalogEntry => ({
      className,
      entityType: `${VARIABLE_TYPE_PREFIX}${type}`,
      kind: "variable",
      entityKind: "property",
      description,
    }),
  ),
];

/**
 * The catalog as a chant lexicon registry, keyed by class name. Every class
 * is listed as a resource, including the property-kind panels, queries and
 * variables: the registry drives `new …` completions, and an author writes
 * `new TimeSeriesPanel(…)` the same way as `new Dashboard(…)`.
 */
export function lexiconRegistry(): Record<string, LexiconEntry> {
  const out: Record<string, LexiconEntry> = {};
  for (const e of [...BUILTIN_CATALOG].sort((a, b) => a.className.localeCompare(b.className))) {
    out[e.className] = { resourceType: e.entityType, kind: "resource", lexicon: "grafana" };
  }
  return out;
}
