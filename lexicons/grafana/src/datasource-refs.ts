/**
 * Which datasource each panel, query and query variable in built dashboard
 * JSON sends its request to.
 *
 * GRAF101 and GRAF102 use this to check references against the datasources
 * a build knows about: the ones it provisions (`Datasource`) and the ones it
 * only references (`ExternalDatasource`). Any other check that needs to know
 * which plugin runs a query (a PromQL syntax check only wants the queries
 * that reach a Prometheus) can call `datasourceUses()` and read
 * `resolved.type`.
 */

import type { ExternalDatasourceRecord, ProvisionedDatasource } from "./build";
import { BUILTIN_DATASOURCE_UIDS } from "./datasource";

type Json = Record<string, unknown>;

/** A `{ type, uid }` datasource reference as dashboard JSON holds it. */
export interface DatasourceRefJson {
  type?: string;
  uid?: string;
}

/** A datasource the build knows by uid: provisioned by it, or declared external. */
export interface KnownDatasource {
  uid: string;
  type: string;
  name?: string;
  /** Declared with `ExternalDatasource`: referenced, not provisioned. */
  external: boolean;
}

/**
 * Where a reference leads.
 *
 * - `declared`: a known datasource; `type` is its plugin type.
 * - `variable`: a `${name}` uid; `type` is the datasource variable's plugin type, else the ref's own.
 * - `builtin`: one of Grafana's pseudo-datasources (`-- Mixed --`, `-- Dashboard --`, `grafana`).
 * - `undeclared`: a uid the build does not know; `type` is whatever the ref says.
 * - `default`: no uid, so Grafana picks its default datasource; `type` is the ref's, if it has one.
 */
export type ResolvedDatasource =
  | { kind: "declared"; type: string; datasource: KnownDatasource }
  | { kind: "variable"; type?: string; variable: string; declared: boolean }
  | { kind: "builtin"; type?: string }
  | { kind: "undeclared"; type?: string; uid: string }
  | { kind: "default"; type?: string };

/** One place a dashboard names, or inherits, a datasource. */
export interface DatasourceUse {
  /** A panel's own `datasource`, one of its queries (`targets`), a query, ad hoc or group by variable, or an annotation query. */
  kind: "panel" | "query" | "variable" | "annotation";
  /** A human description, e.g. `panel "Latency" (id 3) query B`. */
  where: string;
  panel?: Json;
  target?: Json;
  variable?: Json;
  annotation?: Json;
  /** The ref written on this panel, query, variable or annotation; unset when a query inherits its panel's. */
  ref?: DatasourceRefJson;
  /** Where the request goes: the query's own ref, else its panel's. */
  resolved: ResolvedDatasource;
}

/** Every datasource a build knows by uid. A provisioned one wins over an external one of the same uid (GRAF104 reports the clash). */
export function knownDatasources(
  datasources: readonly ProvisionedDatasource[],
  external: readonly ExternalDatasourceRecord[] = [],
): Map<string, KnownDatasource> {
  const out = new Map<string, KnownDatasource>();
  for (const d of external) out.set(d.uid, { uid: d.uid, type: d.type, ...(d.name ? { name: d.name } : {}), external: true });
  for (const d of datasources) out.set(d.uid, { uid: d.uid, type: d.type, name: d.name, external: false });
  return out;
}

export interface PanelInfo {
  panel: Json;
  /** Panels inside a collapsed row are laid out in their own group. */
  group: string;
}

/** Every panel of a dashboard, including those inside collapsed rows, and the rows themselves. */
export function panelsOf(dashboard: Json): PanelInfo[] {
  const out: PanelInfo[] = [];
  const top = Array.isArray(dashboard.panels) ? (dashboard.panels as Json[]) : [];
  for (const p of top) {
    if (!p || typeof p !== "object") continue;
    out.push({ panel: p, group: "" });
    if (p.type === "row" && Array.isArray(p.panels)) {
      for (const c of p.panels as Json[]) if (c && typeof c === "object") out.push({ panel: c, group: `row ${String(p.id)}` });
    }
  }
  return out;
}

export function describePanel(panel: Json): string {
  const title = typeof panel.title === "string" && panel.title ? `"${panel.title}"` : "(untitled)";
  return `panel ${title} (id ${String(panel.id ?? "?")})`;
}

/** A dashboard's `templating.list`. */
export function variablesOf(dashboard: Json): Json[] {
  const list = (dashboard.templating as { list?: unknown } | undefined)?.list;
  return Array.isArray(list) ? (list as Json[]).filter((v) => v && typeof v === "object") : [];
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}|\[\[([A-Za-z_][A-Za-z0-9_]*)(?::[^\]]*)?\]\]|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every variable name referenced in a string. */
export function variableReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR_REF)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function refOf(value: unknown): DatasourceRefJson | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DatasourceRefJson) : undefined;
}

/** Grafana's own pseudo-datasources, which no build declares. */
export function isPseudoRef(ref: DatasourceRefJson): boolean {
  return ref.type === "datasource" || ref.type === "grafana" || (ref.uid !== undefined && BUILTIN_DATASOURCE_UIDS.has(ref.uid));
}

/** The datasource variables of a dashboard, by name. */
function datasourceVariables(dashboard: Json): Map<string, Json> {
  return new Map(variablesOf(dashboard).filter((v) => v.type === "datasource").map((v) => [String(v.name), v]));
}

/** Where one reference leads, given the dashboard's datasource variables and the known datasources. */
export function resolveDatasourceRef(
  ref: DatasourceRefJson | undefined,
  dsVariables: ReadonlyMap<string, Json>,
  known: ReadonlyMap<string, KnownDatasource>,
): ResolvedDatasource {
  if (!ref || (ref.uid === undefined && ref.type === undefined)) return { kind: "default" };
  if (isPseudoRef(ref)) return { kind: "builtin", ...(ref.type ? { type: ref.type } : {}) };
  if (ref.uid === undefined) return { kind: "default", ...(ref.type ? { type: ref.type } : {}) };
  if (ref.uid.includes("$")) {
    const [name] = variableReferences(ref.uid);
    const v = name ? dsVariables.get(name) : undefined;
    const type = v && typeof v.query === "string" && v.query ? v.query : ref.type;
    return { kind: "variable", variable: name ?? ref.uid, declared: v !== undefined, ...(type ? { type } : {}) };
  }
  const datasource = known.get(ref.uid);
  if (datasource) return { kind: "declared", type: datasource.type, datasource };
  return { kind: "undeclared", uid: ref.uid, ...(ref.type ? { type: ref.type } : {}) };
}

/** Variable types that send requests to a datasource of their own: a query variable's query, an ad hoc or group by variable's key and value lookups. */
const DATASOURCE_VARIABLE_TYPES: ReadonlySet<string> = new Set(["query", "adhoc", "groupby"]);

/** A dashboard's `annotations.list`. */
export function annotationsOf(dashboard: Json): Json[] {
  const list = (dashboard.annotations as { list?: unknown } | undefined)?.list;
  return Array.isArray(list) ? (list as Json[]).filter((a) => a && typeof a === "object" && !Array.isArray(a)) : [];
}

/**
 * Every place a dashboard names or inherits a datasource: each panel's own
 * ref, each query (with its own ref, or its panel's when it has none), each
 * query, ad hoc and group by variable, and each annotation query with a datasource. Rows are left
 * out; their panels carry the ref.
 */
export function datasourceUses(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>): DatasourceUse[] {
  const dsVars = datasourceVariables(dashboard);
  const out: DatasourceUse[] = [];
  for (const { panel } of panelsOf(dashboard)) {
    if (panel.type === "row") continue;
    const panelRef = refOf(panel.datasource);
    if (panelRef) out.push({ kind: "panel", where: describePanel(panel), panel, ref: panelRef, resolved: resolveDatasourceRef(panelRef, dsVars, known) });
    // A query under a `-- Mixed --` panel with no ref of its own goes to the default datasource.
    const inherited = panelRef && panelRef.uid !== "-- Mixed --" ? panelRef : undefined;
    const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
    for (const target of targets) {
      if (!target || typeof target !== "object") continue;
      const own = refOf(target.datasource);
      out.push({
        kind: "query",
        where: `${describePanel(panel)} query ${String(target.refId ?? "?")}`,
        panel,
        target,
        ...(own ? { ref: own } : {}),
        resolved: resolveDatasourceRef(own ?? inherited, dsVars, known),
      });
    }
  }
  for (const variable of variablesOf(dashboard)) {
    if (!DATASOURCE_VARIABLE_TYPES.has(String(variable.type))) continue;
    const ref = refOf(variable.datasource);
    out.push({
      kind: "variable",
      where: `variable "${String(variable.name)}"`,
      variable,
      ...(ref ? { ref } : {}),
      resolved: resolveDatasourceRef(ref, dsVars, known),
    });
  }
  for (const annotation of annotationsOf(dashboard)) {
    const ref = refOf(annotation.datasource);
    if (!ref) continue;
    const target = refOf(annotation.target) as Json | undefined;
    out.push({
      kind: "annotation",
      where: `annotation "${String(annotation.name ?? "?")}"`,
      annotation,
      ...(target ? { target } : {}),
      ref,
      resolved: resolveDatasourceRef(ref, dsVars, known),
    });
  }
  return out;
}
