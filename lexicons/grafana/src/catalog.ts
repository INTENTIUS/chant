/**
 * The built-in entity catalog: every class this package exports, keyed by
 * class name. It feeds the packaged registry (`dist/meta.json`), LSP
 * completions and hover, and the docs.
 */

import type { LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { DATASOURCE_TYPE } from "./datasource";
import { DASHBOARD_TYPE, DASHBOARD_PROVIDER_TYPE } from "./dashboard";
import * as panels from "./panels";
import * as queries from "./query";
import { VARIABLE_TYPE_PREFIX } from "./variables";

export type CatalogKind = "dashboard" | "datasource" | "provider" | "panel" | "row" | "query" | "variable";

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
