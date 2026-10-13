/**
 * Live Grafana objects -> chant's vocabulary, pure (#2946).
 *
 * Two consumers, one mapping:
 *
 * - live export (`../export-resources.ts`) turns dashboards and
 *   datasources read over the API into `TemplateIR` that feeds
 *   `templateGenerator()` unchanged;
 * - deep observation (`../deep-observe.ts`) turns one live dashboard into
 *   the property tree core diffs against the declaration.
 *
 * Both go through the importer (`./parser.ts`), so a dashboard read from
 * Grafana and a dashboard file given to `chant import` become the same
 * declarations. The importer is not changed here; this module only reads
 * the plan it makes.
 *
 * ## Why the drift tree is in chant's vocabulary, not Grafana's
 *
 * Core diffs a declaration's `props` (with property-kind declarables, which
 * panels, rows, queries and variables are, inlined as their own props)
 * against the tree a reader returns. A `Dashboard`'s props are what the
 * author wrote: `graphTooltip: "sharedCrosshair"`, `panels: [Row, ...]`, a
 * query with no `refId`. The JSON Grafana stores is what the build wrote
 * from them: `graphTooltip: 1`, a flat panel list, `refId: "A"`. So the
 * live side has to be put into the author's vocabulary, and the importer
 * is exactly that translation, already tested to round-trip. Reading the
 * plan back as one tree (every reference replaced by what it refers to)
 * gives the live counterpart of the declared tree.
 *
 * What the translation cannot decide on its own (a panel `id` the build
 * numbered, a `gridPos` it laid out, the built-in annotation Grafana adds)
 * is noise, and noise is named in `../deep-observe-hooks.ts`, which core
 * applies to both trees.
 */

import type { ResourceIR, TemplateIR } from "@intentius/chant/import/parser";
import { isDeclRef, type Declaration, type Plan } from "./model";
import {
  DASHBOARD_RESOURCE_TYPE,
  PROVISIONING_RESOURCE_TYPE,
  planDashboard,
  planDatasourceProvisioning,
  type DashboardResourceMetadata,
  type PlanResourceProperties,
} from "./parser";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The dashboard declaration of a plan as one property tree: each reference
 * replaced by the props (or, for a `DatasourceRef` const, the value) of the
 * declaration it names, the way core inlines a property-kind declarable.
 */
export function planTree(plan: Plan): Json {
  const byId = new Map<string, Declaration>(plan.declarations.map((d) => [d.id, d]));
  const resolve = (value: unknown, seen: ReadonlySet<string>): unknown => {
    if (isDeclRef(value)) {
      const decl = byId.get(value.$decl);
      if (!decl || seen.has(decl.id)) return undefined;
      const next = new Set(seen).add(decl.id);
      return resolve(decl.kind === "value" ? decl.value : (decl.props ?? {}), next);
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, seen)).filter((v) => v !== undefined);
    if (isObject(value)) {
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) {
        const r = resolve(v, seen);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return value;
  };
  const dashboard = byId.get("dashboard");
  if (!dashboard) return {};
  return resolve(dashboard.props ?? {}, new Set(["dashboard"])) as Json;
}

/** One live dashboard (classic JSON) as the property tree core diffs a `Dashboard` declaration against. */
export function dashboardTree(dashboard: Json): { tree: Json; warnings: string[] } {
  const { plan, warnings } = planDashboard(dashboard);
  return { tree: planTree(plan), warnings };
}

/** The keys a datasource's props take (`DatasourceProps`), in the order they are written. */
export const DATASOURCE_PROP_KEYS: readonly string[] = [
  "name",
  "type",
  "uid",
  "url",
  "access",
  "isDefault",
  "basicAuth",
  "basicAuthUser",
  "user",
  "database",
  "withCredentials",
  "jsonData",
  "secureJsonData",
  "editable",
  "orgId",
  "version",
];

/**
 * Grafana's value for a datasource key the API always returns, where it
 * means "not set". Export leaves these out so the generated source says what
 * somebody chose, as a provisioning file would.
 */
export const DATASOURCE_API_DEFAULTS: Readonly<Json> = {
  access: "proxy",
  isDefault: false,
  basicAuth: false,
  basicAuthUser: "",
  user: "",
  database: "",
  withCredentials: false,
  jsonData: {},
};

/**
 * One datasource from `GET /api/datasources[/uid/<uid>]` in `DatasourceProps`
 * vocabulary.
 *
 * - `readOnly` (the API's word) becomes `editable` (the provisioning file's).
 * - `secureJsonFields` names which secrets are set and never their values;
 *   they become `secureJsonData` keys whose value is `[REDACTED]`, so the
 *   key set compares and nothing secret is ever held.
 * - `id`, `orgId`, `version`, `typeName`, `typeLogoUrl`, `apiVersion` and the
 *   rest are the server's own and are left out.
 *
 * `keepDefaults` keeps keys at the API's "not set" value (`--verbatim`).
 */
export function datasourceProps(live: Json, options: { keepDefaults?: boolean } = {}): Json {
  const out: Json = {};
  for (const key of DATASOURCE_PROP_KEYS) {
    if (key === "secureJsonData" || key === "editable" || key === "orgId" || key === "version") continue;
    const v = live[key];
    if (v === undefined || v === null) continue;
    if (!options.keepDefaults && key in DATASOURCE_API_DEFAULTS && deepEqualJson(v, DATASOURCE_API_DEFAULTS[key])) continue;
    out[key] = v;
  }
  const secure = isObject(live.secureJsonFields) ? Object.keys(live.secureJsonFields).filter((k) => live.secureJsonFields && (live.secureJsonFields as Json)[k] === true) : [];
  if (secure.length > 0) out.secureJsonData = Object.fromEntries(secure.sort().map((k) => [k, "[REDACTED]"]));
  if (typeof live.readOnly === "boolean") {
    const editable = !live.readOnly;
    if (editable || options.keepDefaults) out.editable = editable;
  }
  return out;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── export ──────────────────────────────────────────────────────────

/**
 * A dashboard plan whose `ExternalDatasource`s for the given uids are
 * written as plain `{ type, uid }` refs instead.
 *
 * The importer declares an `ExternalDatasource` for each datasource a
 * dashboard names, because a dashboard file alone does not say where its
 * datasources come from. A live export does know, when it exports the
 * datasources too: they become `Datasource` declarations, and an
 * `ExternalDatasource` with the same uid beside them fails the build (two
 * datasources, one uid). A plain ref is what the importer itself writes when
 * it cannot declare an external one (`settleExternals`), and GRAF101 still
 * checks it against the declared `Datasource`.
 */
export function referDeclaredDatasources(plan: Plan, uids: ReadonlySet<string>): Plan {
  const replaced = new Set<string>();
  const declarations = plan.declarations.map((d): Declaration => {
    if (d.kind !== "new" || d.className !== "ExternalDatasource") return d;
    const { type, uid } = (d.props ?? {}) as { type?: unknown; uid?: unknown };
    if (typeof type !== "string" || typeof uid !== "string" || !uids.has(uid)) return d;
    replaced.add(d.id);
    return {
      id: d.id,
      kind: "value",
      value: { type, uid },
      type: { text: `DatasourceRef<${JSON.stringify(type)}>`, imports: ["DatasourceRef"] },
      name: d.name,
      module: d.module,
      comment: [`// Declared as a Datasource in datasources.ts, which this export also writes.`],
    };
  });
  if (replaced.size === 0) return plan;
  return { ...plan, declarations, exports: plan.exports.filter((id) => !replaced.has(id)) };
}

function logicalIdFor(text: string): string {
  const w = text.split(/[^A-Za-z0-9]+/).filter((x) => x !== "");
  const id = w.map((x, i) => (i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  return id === "" || /^[0-9]/.test(id) ? `dashboard${id.charAt(0).toUpperCase()}${id.slice(1)}` : id;
}

/**
 * Live dashboards and datasources as import IR, for `chant import --from`.
 *
 * Each dashboard is planned by the importer exactly as a dashboard file
 * would be, so the generated TypeScript is what `chant import` writes for
 * the same JSON, except that a datasource exported alongside it is referred
 * to by `{ type, uid }` (see `referDeclaredDatasources`). The datasources are
 * planned as one provisioning file, with
 * the secrets Grafana holds written as `[REDACTED]`: the generated source
 * shows which secrets are set and must be filled in by hand (as
 * `$__env{NAME}` references, which GRAF002 asks for).
 */
export function exportTemplate(input: {
  dashboards: Array<{ json: Json; warnings?: string[] }>;
  datasources: Json[];
  keepDefaults?: boolean;
}): TemplateIR {
  const resources: ResourceIR[] = [];
  const warnings: string[] = [];
  const taken = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    taken.add(id);
    return id;
  };

  const exportedUids = new Set(input.datasources.map((ds) => ds.uid).filter((u): u is string => typeof u === "string"));
  for (const d of input.dashboards) {
    warnings.push(...(d.warnings ?? []));
    const planned = planDashboard(d.json);
    const { edits, warnings: planWarnings } = planned;
    const plan = referDeclaredDatasources(planned.plan, exportedUids);
    const title = typeof d.json.title === "string" && d.json.title !== "" ? d.json.title : String(d.json.uid ?? "dashboard");
    const uid = typeof d.json.uid === "string" ? d.json.uid : title;
    warnings.push(...planWarnings.map((w) => `dashboard ${uid}: ${w}`));
    const metadata: DashboardResourceMetadata = { source: d.json, edits };
    const properties: PlanResourceProperties = { plan };
    resources.push({
      logicalId: unique(logicalIdFor(title)),
      type: DASHBOARD_RESOURCE_TYPE,
      properties: properties as unknown as Json,
      metadata: metadata as unknown as Json,
    });
  }

  if (input.datasources.length > 0) {
    const entries = input.datasources.map((ds) => datasourceProps(ds, { keepDefaults: input.keepDefaults }));
    const redacted = entries.filter((e) => isObject(e.secureJsonData)).map((e) => `"${String(e.name)}"`);
    if (redacted.length > 0) {
      warnings.push(
        `datasources: Grafana does not return secret values, so the secureJsonData of ${redacted.join(", ")} is written as [REDACTED]; ` +
          "replace each with a $__env{NAME} or $__file{path} reference before building",
      );
    }
    const { plan, warnings: dsWarnings } = planDatasourceProvisioning({ apiVersion: 1, datasources: entries });
    warnings.push(...dsWarnings);
    const properties: PlanResourceProperties = { plan };
    resources.push({ logicalId: unique("datasources"), type: PROVISIONING_RESOURCE_TYPE, properties: properties as unknown as Json });
  }

  return { resources, parameters: [], warnings };
}
