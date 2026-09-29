/**
 * Dashboard JSON (and Grafana's provisioning files) -> `TemplateIR`, for
 * `chant import`.
 *
 * A dashboard's parts refer to each other: panels name datasources and
 * variables, rows hold panels, the dashboard lists them all. So the IR
 * carries one resource per dashboard, of type `Grafana::Dashboard`, whose
 * properties are a `Plan` (./model.ts): the declarations the dashboard
 * becomes and the references between them. The generator lays the plan out
 * in modules. (Core splits an IR with more than three resources into one
 * generate() call per category and keeps only the first file of each,
 * which would lose the imports between a row and its panels; #2964 lets a
 * lexicon opt out of that.)
 *
 * What each JSON key becomes is decided by the tables in ./mappings.ts.
 * Whatever cannot be carried is named in `warnings` and recorded as an
 * edit (./edits.ts) in the resource's metadata; a key left out at the value
 * Grafana assumes anyway (./normalize.ts) is an edit with no warning.
 *
 * Accepted input:
 *
 * - classic dashboard JSON, as the UI exports it, with or without "Export
 *   for sharing externally" (`__inputs`, `__requires`, `__elements`);
 * - the same wrapped in a `dashboard.grafana.app` v0/v1 resource (`spec`),
 *   or in the `{ dashboard, meta }` of `GET /api/dashboards/uid/<uid>`;
 * - a datasource or dashboard provisioning file.
 *
 * A v2 dashboard, or one saved before Grafana 5.0 (panels inside a
 * top-level `rows` list), is recognised and reported, and nothing is
 * imported from it.
 *
 * Deliberate changes, each with a warning:
 *
 * - An `__inputs` datasource (`${DS_PROMETHEUS}`) becomes a
 *   `DatasourceVariable` of the same name, so every `${DS_PROMETHEUS}` in
 *   the dashboard still resolves, now to whatever the variable selects.
 * - An `__inputs` constant is replaced by its value, as Grafana's import
 *   dialog would.
 * - The stored copy's `id`, `version` and `iteration` are Grafana's
 *   bookkeeping and are dropped without a warning.
 */

import * as jsYaml from "js-yaml";
import type { TemplateIR, TemplateParser, ResourceIR } from "@intentius/chant/import/parser";
import { DASHBOARD_SCHEMA_VERSION } from "../schema/dashboard.gen";
import { BUILTIN_DATASOURCE_UIDS } from "../datasource";
import {
  looksLikeDashboard,
  looksLikeDashboardApiResponse,
  looksLikeDashboardProvisioning,
  looksLikeDashboardResource,
  looksLikeDatasourceProvisioning,
  looksLikeLegacyRowsDashboard,
  looksLikeV2Dashboard,
} from "../detect";
import { slugUid } from "../util";
import { pointer, type ImportEdit } from "./edits";
import {
  COMMON_VARIABLE_KEYS,
  DASHBOARD_FIELDS,
  DEFAULT_DATASOURCE_TYPE,
  GRAPH_TOOLTIP,
  PANEL_FIELDS,
  ROW_FIELDS,
  VARIABLE_HIDE,
  VARIABLE_MAPPINGS,
  builtinPanelFor,
  builtinQueryFor,
  type VariableContext,
} from "./mappings";
import { declRef, type CustomClass, type Declaration, type DeclRef, type ModuleSpec, type Plan } from "./model";
import {
  BOOKKEEPING_KEYS,
  DASHBOARD_DEFAULTS,
  MIXED_UID,
  PANEL_DEFAULTS,
  ROW_DEFAULTS,
  canonicalVariableUid,
  deepEqual,
  isBuiltinAnnotation,
  isDefault,
  isObject,
  variableDefaults,
} from "./normalize";

type Json = Record<string, unknown>;

/** The IR resource type for one dashboard. */
export const DASHBOARD_RESOURCE_TYPE = "Grafana::Dashboard";
/** The IR resource type for a datasource or dashboard provisioning file. */
export const PROVISIONING_RESOURCE_TYPE = "Grafana::Provisioning";

/** `properties` of a `Grafana::Dashboard` or `Grafana::Provisioning` resource. */
export interface PlanResourceProperties {
  plan: Plan;
}

/** `metadata` of a `Grafana::Dashboard` resource. */
export interface DashboardResourceMetadata {
  /** The dashboard JSON the plan was made from (unwrapped from a resource or API response). */
  source: Json;
  /** What the importer did to it: apply these to `source` to get what the rebuilt dashboard should equal. */
  edits: ImportEdit[];
}

/** The panel plugin id format `definePanel` accepts. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-_]*$/;

const VARIABLE_UID = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\[\[([A-Za-z_][A-Za-z0-9_]*)\]\])$/;

/** Class names the package exports, which a class the import declares must not take. */
const PACKAGE_CLASS_NAMES = new Set([
  "Dashboard",
  "DashboardProvider",
  "Datasource",
  "Row",
  "QueryVariable",
  "CustomVariable",
  "IntervalVariable",
  "DatasourceVariable",
  "ConstantVariable",
  "TextboxVariable",
  "PromQuery",
  "TempoQuery",
  "LokiQuery",
  "TimeSeriesPanel",
  "StatPanel",
  "GaugePanel",
  "TablePanel",
  "LogsPanel",
  "TracesPanel",
  "HeatmapPanel",
  "TextPanel",
]);

function words(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
}

function pascal(text: string): string {
  return words(text)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function describePanel(p: Json): string {
  const title = typeof p.title === "string" && p.title !== "" ? `"${p.title}"` : "(untitled)";
  return `panel ${title}${p.id !== undefined ? ` (id ${String(p.id)})` : ""}`;
}

function list(keys: string[]): string {
  return keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

/** Collects edits, and warnings grouped by what they are about. */
class Report {
  readonly edits: ImportEdit[] = [];
  private readonly headlines: string[] = [];
  private readonly grouped = new Map<string, { subject: string; keys: string[]; why: string; kind: "drop" | "replace" }>();

  /** A warning of its own. */
  warn(message: string): void {
    this.headlines.push(message);
  }

  /** `key` of `subject`, at `path`, is not carried. No warning when `why` is undefined (it is at Grafana's default). */
  drop(path: string, subject: string, key: string, why?: string): void {
    this.edits.push({ op: "remove", path });
    if (why !== undefined) this.note("drop", subject, key, why);
  }

  /**
   * The value at `path` is written as `value`. No warning when `why` is
   * undefined (Grafana reads both the same); otherwise the warning reads
   * `<subject>: <key> <why>`.
   */
  replace(path: string, value: unknown, subject: string, key: string, why?: string): void {
    this.edits.push({ op: "replace", path, value });
    if (why !== undefined) this.note("replace", subject, key, why);
  }

  edit(edit: ImportEdit): void {
    this.edits.push(edit);
  }

  private note(kind: "drop" | "replace", subject: string, key: string, why: string): void {
    const k = `${kind}\u0000${subject}\u0000${why}`;
    const g = this.grouped.get(k) ?? { subject, keys: [], why, kind };
    g.keys.push(key);
    this.grouped.set(k, g);
  }

  warnings(): string[] {
    const out = [...this.headlines];
    for (const g of this.grouped.values()) {
      const n = g.keys.length;
      const why = g.why === NO_PROP ? `(no prop takes ${n === 1 ? "it" : "them"})` : g.why;
      if (n === 0 || g.keys[0] === "") out.push(`${g.subject} ${why}`);
      else if (g.kind === "replace") out.push(`${g.subject}: ${list(g.keys)} ${why}`);
      else out.push(`${g.subject}: ${list(g.keys)} ${n === 1 ? "is" : "are"} not carried ${why}`);
    }
    return out;
  }
}

const NO_PROP = "(no prop takes it)";


/** A resolved datasource reference: the prop value, the plugin type when known, and a key for comparing two. */
interface ResolvedDs {
  value: DeclRef;
  type?: string;
  key: string;
  /** The `{ type, uid }` the build writes for it. */
  written: { type: string; uid: string };
}

type Resolution = ResolvedDs | "mixed" | undefined;

interface DatasourceVariableInfo {
  declId: string;
  pluginType: string;
}

/** The state of one dashboard's conversion. */
class DashboardConverter {
  readonly declarations: Declaration[] = [];
  readonly customClasses = new Map<string, CustomClass>();
  private readonly modules = new Map<string, ModuleSpec>();
  private readonly refDecls = new Map<string, string>();
  /** Datasource variables (and `__inputs` datasources) by name. */
  private readonly datasourceVariables = new Map<string, DatasourceVariableInfo>();
  /** Every declared variable by name, for `repeat`. */
  private readonly variables = new Map<string, string>();
  private panelCount = 0;
  private rowCount = 0;
  private legacyPanels = 0;
  private readonly legacyTypes = new Set<string>();
  private readonly takenModuleFiles = new Set<string>();

  constructor(
    private readonly d: Json,
    private readonly report: Report,
  ) {}

  // ── modules and custom classes ──────────────────────────────────

  private module(key: string, file: string, summary: string): string {
    if (!this.modules.has(key)) {
      let f = file;
      for (let n = 2; this.takenModuleFiles.has(f); n++) f = `${file}-${n}`;
      this.takenModuleFiles.add(f);
      this.modules.set(key, { key, file: f, summary });
    }
    return key;
  }

  private customClassName(base: string): string {
    const taken = new Set([...PACKAGE_CLASS_NAMES, ...[...this.customClasses.values()].map((c) => c.className)]);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    return name;
  }

  /** The class for a panel of this type: a built-in, or a `definePanel` the import declares. */
  private panelClass(type: string): { className: string; customClass?: string } {
    const builtin = builtinPanelFor(type);
    if (builtin) return { className: builtin.className };
    const id = `panel-class:${type}`;
    let custom = this.customClasses.get(id);
    if (!custom) {
      this.module("plugins", "plugins", "Panel and query classes for plugins chant has no class for");
      const className = this.customClassName(`${/^[0-9]/.test(type) ? "Plugin" : ""}${pascal(type) || "Custom"}Panel`);
      custom = {
        id,
        className,
        factory: "definePanel",
        definition: { type, className, defaultSize: { w: 12, h: 8 } },
        comment: [
          `// The "${type}" panel is not one chant has a class for, so its options are carried as data`,
          "// and are not type-checked. Give definePanel an options type to check them.",
        ],
      };
      this.customClasses.set(id, custom);
    }
    return { className: custom.className, customClass: id };
  }

  /** The class for a query to a datasource of this type: a built-in, or a `defineQuery` the import declares. */
  private queryClass(datasourceType: string): { className: string; customClass?: string } {
    const builtin = builtinQueryFor(datasourceType);
    if (builtin) return { className: builtin.className };
    const id = `query-class:${datasourceType}`;
    let custom = this.customClasses.get(id);
    if (!custom) {
      this.module("plugins", "plugins", "Panel and query classes for plugins chant has no class for");
      const isDefault = datasourceType === DEFAULT_DATASOURCE_TYPE;
      const className = this.customClassName(isDefault ? "DefaultDatasourceQuery" : `${pascal(datasourceType) || "Custom"}Query`);
      custom = {
        id,
        className,
        factory: "defineQuery",
        definition: { datasourceType, className },
        comment: isDefault
          ? [
              "// Queries that name no datasource, on panels that name none: Grafana sends them to its",
              "// default datasource. The query model is carried as data and is not type-checked.",
            ]
          : [
              `// Queries to "${datasourceType}" datasources, which chant has no query class for, so the`,
              "// query model is carried as data and is not type-checked. Give defineQuery a model type to check it.",
            ],
      };
      this.customClasses.set(id, custom);
    }
    return { className: custom.className, customClass: id };
  }

  private add(decl: Declaration): string {
    this.declarations.push(decl);
    return decl.id;
  }

  // ── datasources ─────────────────────────────────────────────────

  /** Datasources the dashboard references by uid, declared as `ExternalDatasource`s; exported so the build sees them. */
  readonly externals: string[] = [];

  /**
   * The declaration for a datasource referenced by uid: an
   * `ExternalDatasource` (it exists in Grafana, outside this dashboard), or,
   * for one of Grafana's own pseudo-datasources, a `DatasourceRef` const.
   */
  private refDecl(type: string, uid: string): ResolvedDs {
    const key = `${type}\u0000${uid}`;
    let id = this.refDecls.get(key);
    if (!id) {
      id = `datasource:${type}:${uid}`;
      this.module("datasources", "datasources", "Datasources the panels and queries refer to, by the uid they have in Grafana");
      const pseudo = BUILTIN_DATASOURCE_UIDS.has(uid) || type === "datasource" || type === "grafana" || uid.includes("$");
      if (pseudo) {
        const hint = uid.includes("$") ? `${type} datasource` : `${uid.replace(/-/g, " ")} datasource`;
        this.add({
          id,
          kind: "value",
          value: { type, uid },
          type: { text: `DatasourceRef<${JSON.stringify(type)}>`, imports: ["DatasourceRef"] },
          name: hint,
          module: "datasources",
        });
      } else {
        const hint = /^[A-Za-z][A-Za-z0-9_-]{0,24}$/.test(uid) ? uid : `${type} datasource`;
        this.add({ id, kind: "new", className: "ExternalDatasource", props: { type, uid }, name: hint, module: "datasources" });
        this.externals.push(id);
      }
      this.refDecls.set(key, id);
    }
    return { value: declRef(id), type, key, written: { type, uid } };
  }

  /**
   * GRAF101 checks a datasource variable against the declared datasources of
   * its type. When the dashboard names some datasources by uid but a
   * datasource variable's type is not among them, declaring the others would
   * make GRAF101 fail the build over a datasource the dashboard never names;
   * then the uids are written as plain refs instead, and the warning says
   * what to declare.
   */
  private settleExternals(): void {
    if (this.externals.length === 0) return;
    const covered = new Set(this.externals.map((id) => String(this.declarations.find((d) => d.id === id)!.props!.type)));
    const uncovered = [...this.datasourceVariables.entries()].filter(([, v]) => !covered.has(v.pluginType));
    if (uncovered.length === 0) return;
    const uids: string[] = [];
    for (const id of this.externals) {
      const i = this.declarations.findIndex((d) => d.id === id);
      const { type, uid } = this.declarations[i].props as { type: string; uid: string };
      uids.push(`"${uid}" (${type})`);
      this.declarations[i] = {
        id,
        kind: "value",
        value: { type, uid },
        type: { text: `DatasourceRef<${JSON.stringify(type)}>`, imports: ["DatasourceRef"] },
        name: this.declarations[i].name,
        module: "datasources",
      };
    }
    this.externals.length = 0;
    const vars = uncovered.map(([name, v]) => `$${name} (${v.pluginType})`);
    this.report.warn(
      `datasources: the dashboard names ${list(uids)} by uid, but no ${[...new Set(uncovered.map(([, v]) => v.pluginType))].join(" or ")} datasource, ` +
        `which ${list(vars)} ${vars.length === 1 ? "chooses" : "choose"} among. They are written as plain { type, uid } refs rather than ExternalDatasources, ` +
        "so GRAF101 and GRAF102 do not check them; declare an ExternalDatasource for each, and one of each variable's type, to have them checked.",
    );
  }

  /**
   * A `datasource` value as a prop: a declared datasource variable, or a
   * `DatasourceRef` const. Records the edit when it is written differently
   * or cannot be carried.
   */
  resolveDatasource(value: unknown, path: string, subject: string): Resolution {
    if (value === undefined || value === null) return undefined;
    let ref: { type?: string; uid?: string };
    if (typeof value === "string") {
      // A reference by name, from before Grafana 8.3.
      if (value === "" || value === "default") {
        this.report.drop(path, subject, "datasource");
        return undefined;
      }
      if (value === MIXED_UID) return "mixed";
      if (value === "-- Grafana --" || value === "grafana") ref = { type: "grafana", uid: "-- Grafana --" };
      else if (value === "-- Dashboard --") ref = { type: "datasource", uid: "-- Dashboard --" };
      else if (VARIABLE_UID.test(value)) ref = { uid: value };
      else {
        this.report.drop(path, subject, "datasource", `(it names the datasource "${value}" rather than its uid, from before Grafana 8.3)`);
        return undefined;
      }
    } else if (isObject(value)) {
      ref = { type: typeof value.type === "string" ? value.type : undefined, uid: typeof value.uid === "string" ? value.uid : undefined };
      const extra = Object.keys(value).filter((k) => k !== "type" && k !== "uid" && value[k] !== undefined);
      if (extra.length > 0) {
        this.report.drop(path, subject, "datasource", `(it has ${list(extra)} besides type and uid)`);
        return undefined;
      }
    } else {
      this.report.drop(path, subject, "datasource", "(it is not a datasource reference)");
      return undefined;
    }

    if (ref.uid === undefined || ref.uid === "") {
      this.report.drop(path, subject, "datasource", `(it names no uid${ref.type ? `, only the type ${ref.type}` : ""})`);
      return undefined;
    }
    if (ref.uid === MIXED_UID) return "mixed";

    const variable = VARIABLE_UID.exec(ref.uid);
    if (variable) {
      const name = variable[1] ?? variable[2] ?? variable[3];
      const dsVar = this.datasourceVariables.get(name);
      if (dsVar && (ref.type === undefined || ref.type === dsVar.pluginType)) {
        const written = { type: dsVar.pluginType, uid: `\${${name}}` };
        const resolved: ResolvedDs = { value: declRef(dsVar.declId), type: dsVar.pluginType, key: `var\u0000${name}`, written };
        if (!deepEqual(value, written) && !(isObject(value) && value.type === written.type && canonicalVariableUid(String(value.uid)) === written.uid)) {
          this.report.replace(path, written, subject, "datasource");
        }
        return resolved;
      }
      if (ref.type === undefined) {
        this.report.drop(path, subject, "datasource", `(it refers to $${name}, which is not a datasource variable of this dashboard)`);
        return undefined;
      }
      const resolved = this.refDecl(ref.type, canonicalVariableUid(ref.uid));
      if (typeof value === "string") this.report.replace(path, { type: ref.type, uid: canonicalVariableUid(ref.uid) }, subject, "datasource");
      return resolved;
    }

    if (ref.type === undefined) {
      const pseudo: Record<string, string> = { "-- Grafana --": "grafana", grafana: "grafana", "-- Dashboard --": "datasource" };
      if (pseudo[ref.uid]) ref.type = pseudo[ref.uid];
      else {
        this.report.drop(path, subject, "datasource", `(it names the uid "${ref.uid}" but not the datasource's type)`);
        return undefined;
      }
    }
    const resolved = this.refDecl(ref.type, ref.uid);
    if (!isObject(value) || value.type !== ref.type || value.uid !== ref.uid) {
      this.report.replace(path, { type: ref.type, uid: ref.uid }, subject, "datasource");
    }
    return resolved;
  }

  // ── __inputs ────────────────────────────────────────────────────

  /** Datasource inputs become datasource variables, declared ahead of the dashboard's own. */
  inputVariables(templateNames: Set<string>): string[] {
    const ids: string[] = [];
    const inputs = Array.isArray(this.d.__inputs) ? this.d.__inputs : [];
    const made: string[] = [];
    inputs.forEach((input, i) => {
      if (!isObject(input) || typeof input.name !== "string") return;
      if (input.type === "constant") return;
      if (input.type !== "datasource" || typeof input.pluginId !== "string") {
        this.report.drop(pointer("__inputs", i), "__inputs", input.name, `(an input of type ${String(input.type)} chant has no place for)`);
        return;
      }
      if (templateNames.has(input.name)) return; // the dashboard declares it itself
      this.module("variables", "variables", "Variables, in the order the dashboard lists them");
      const id = `variable:${input.name}`;
      const props: Json = { name: input.name };
      const label = typeof input.label === "string" && input.label !== "" ? input.label : undefined;
      if (label) props.label = label;
      props.pluginType = input.pluginId;
      this.add({
        id,
        kind: "new",
        className: "DatasourceVariable",
        props,
        name: input.name,
        module: "variables",
        comment: [`// From __inputs: the dashboard was exported for sharing, with ${input.name} for its ${input.pluginName ?? input.pluginId} datasource.`],
      });
      this.datasourceVariables.set(input.name, { declId: id, pluginType: input.pluginId });
      this.variables.set(input.name, id);
      this.report.edit({
        op: "prependVariable",
        value: { type: "datasource", name: input.name, ...(label ? { label } : {}), query: input.pluginId, regex: "", refresh: 1, options: [] },
      });
      ids.push(id);
      made.push(`${input.name} (${input.pluginId})`);
    });
    if (made.length > 0) {
      this.report.warn(
        `__inputs: ${list(made)} ${made.length === 1 ? "becomes a datasource variable" : "become datasource variables"} of the same name, ` +
          "so the dashboard asks for its datasources in its variable bar rather than in Grafana's import dialog",
      );
    }
    return ids;
  }

  // ── variables ───────────────────────────────────────────────────

  variable(json: unknown, index: number): string | undefined {
    const path = pointer("templating", "list", index);
    if (!isObject(json) || typeof json.name !== "string") {
      this.report.drop(path, "templating", `entry ${index}`, "(it is not a named variable)");
      return undefined;
    }
    const name = json.name;
    const subject = `variable "${name}"`;
    const type = String(json.type);
    const mapping = VARIABLE_MAPPINGS[type];
    if (!mapping) {
      this.report.drop(path, subject, "", `(${type}) is not carried: chant has no ${type} variable yet (#2952), so it is left out`);
      return undefined;
    }
    let dropped = false;
    const defaults = variableDefaults(type);
    const ctx: VariableContext = {
      json,
      path,
      datasource: (value, p) => {
        const r = this.resolveDatasource(value, p, subject);
        return r === "mixed" || r === undefined ? undefined : r.value;
      },
      drop: (key, why) => this.report.drop(`${path}${pointer(key)}`, subject, key, why ?? NO_PROP),
      dropVariable: (why) => {
        dropped = true;
        this.report.drop(path, subject, "", `is not carried: ${why}, so it is left out`);
      },
      replace: (key, value, why) => this.report.replace(`${path}${pointer(key)}`, value, subject, key, why),
    };
    const specific = mapping.convert(ctx);
    if (dropped || specific === undefined) return undefined;

    const props: Json = { name };
    if (typeof json.label === "string" && json.label !== "") props.label = json.label;
    if (typeof json.description === "string" && json.description !== "") props.description = json.description;
    if (type !== "constant" && typeof json.hide === "number" && json.hide !== 0) {
      const hide = VARIABLE_HIDE[json.hide];
      if (hide) props.hide = hide;
      else this.report.drop(`${path}/hide`, subject, "hide", `(${json.hide} is not a hide value Grafana has)`);
    }
    if (json.skipUrlSync === true) props.skipUrlSync = true;
    Object.assign(props, specific);

    const known = new Set([...COMMON_VARIABLE_KEYS, ...mapping.keys]);
    for (const key of Object.keys(json)) {
      if (known.has(key)) continue;
      this.report.drop(`${path}${pointer(key)}`, subject, key, isDefault(defaults, key, json[key]) ? undefined : NO_PROP);
    }

    this.module("variables", "variables", "Variables, in the order the dashboard lists them");
    const id = `variable:${name}`;
    this.add({ id, kind: "new", className: mapping.className, props, name, module: "variables" });
    this.variables.set(name, id);
    if (type === "datasource") {
      const pluginType = String(props.pluginType);
      this.datasourceVariables.set(name, { declId: id, pluginType });
      // Since Grafana 8.3 the selected value is the datasource's uid and the text its name: a datasource that exists.
      const cur = isObject(json.current) ? json.current : {};
      if (typeof cur.value === "string" && cur.value !== "" && !cur.value.includes("$") && cur.value !== cur.text) {
        this.refDecl(pluginType, cur.value);
      }
    }
    return id;
  }

  // ── panels and rows ─────────────────────────────────────────────

  private copyFields(json: Json, fields: readonly string[], defaults: Readonly<Json>, props: Json): void {
    for (const key of fields) {
      if (!(key in json)) continue;
      const v = json[key];
      if (v === null || v === undefined) continue;
      if (key !== "id" && key !== "title" && isDefault(defaults, key, v)) continue;
      props[key] = v;
    }
  }

  /** One panel, with its queries; returns the panel's declaration id. */
  panel(json: unknown, path: string, module: string, rowDatasource: Resolution): string | undefined {
    if (!isObject(json)) {
      this.report.drop(path, "panels", "", "(an entry that is not a panel) is not carried");
      return undefined;
    }
    const subject = describePanel(json);
    if (isObject(json.libraryPanel)) {
      const lp = json.libraryPanel;
      this.report.drop(
        path,
        subject,
        "",
        `is a library panel ("${String(lp.name ?? lp.uid)}", uid ${String(lp.uid)}); library panels are not carried yet, so it is left out`,
      );
      return undefined;
    }
    const type = typeof json.type === "string" ? json.type : "";
    if (!PLUGIN_ID.test(type) || type === "row") {
      this.report.drop(path, subject, "", `has ${type ? `the type "${type}", which is not a panel plugin id` : "no type"}, so it is left out`);
      return undefined;
    }
    const cls = this.panelClass(type);
    const index = this.panelCount++;
    const id = `panel:${index}`;
    const props: Json = {};
    this.copyFields(json, PANEL_FIELDS, PANEL_DEFAULTS, props);
    const fc = json.fieldConfig;
    if (isObject(fc) && deepEqual(fc, { defaults: {}, overrides: [] })) delete props.fieldConfig;

    const own = this.resolveDatasource(json.datasource, `${path}/datasource`, subject);
    if (own !== undefined && own !== "mixed") props.datasource = own.value;
    // A panel without a datasource of its own inherits its row's in the build; Grafana does not do that.
    const inherited = own === undefined && rowDatasource !== undefined && rowDatasource !== "mixed" ? rowDatasource : undefined;
    if (inherited && (json.datasource === undefined || json.datasource === null)) {
      this.report.replace(
        `${path}/datasource`,
        inherited.written,
        subject,
        "datasource",
        "is missing, and a panel in a chant Row without a datasource takes the row's, so it gets the row's datasource",
      );
    }
    const panelDs: Resolution = own ?? inherited;

    const queries: DeclRef[] = [];
    const targets = Array.isArray(json.targets) ? json.targets : json.targets === undefined || json.targets === null ? [] : undefined;
    if (targets === undefined) this.report.drop(`${path}/targets`, subject, "targets", "(it is not a list)");
    (targets ?? []).forEach((t, i) => {
      const tPath = `${path}/targets/${i}`;
      if (!isObject(t)) {
        this.report.drop(tPath, subject, `query ${i}`, "(it is not an object)");
        return;
      }
      const tds = this.resolveDatasource(t.datasource, `${tPath}/datasource`, `${subject} query ${String(t.refId ?? i)}`);
      const tResolved = tds === "mixed" ? undefined : tds;
      const effectiveType =
        tResolved?.type ?? (panelDs !== undefined && panelDs !== "mixed" ? panelDs.type : undefined) ?? DEFAULT_DATASOURCE_TYPE;
      const qcls = this.queryClass(effectiveType);
      const qprops: Json = {};
      for (const [k, v] of Object.entries(t)) {
        if (k === "datasource") continue;
        qprops[k] = v;
      }
      const panelKey = panelDs !== undefined && panelDs !== "mixed" ? panelDs.key : undefined;
      if (tResolved !== undefined && tResolved.key !== panelKey) qprops.datasource = tResolved.value;
      const qid = `query:${index}:${i}`;
      this.add({
        id: qid,
        kind: "new",
        className: qcls.className,
        customClass: qcls.customClass,
        props: qprops,
        name: { of: id, suffix: typeof t.refId === "string" && t.refId !== "" ? t.refId : `query ${i}` },
        module,
        unit: id,
      });
      queries.push(declRef(qid));
    });
    if (queries.length > 0) props.targets = queries;

    if (typeof json.repeat === "string" && json.repeat !== "") {
      const v = this.variables.get(json.repeat);
      props.repeat = v ? declRef(v) : json.repeat;
    }

    const handled = new Set([...PANEL_FIELDS, "type", "datasource", "targets", "repeat", "libraryPanel"]);
    const extra: string[] = [];
    for (const key of Object.keys(json)) {
      if (handled.has(key)) continue;
      const v = json[key];
      if (v === null || v === undefined || isDefault(PANEL_DEFAULTS, key, v)) {
        this.report.drop(`${path}${pointer(key)}`, subject, key);
        continue;
      }
      extra.push(key);
      this.report.drop(`${path}${pointer(key)}`, subject, key, NO_PROP);
    }
    if (extra.length >= 3 && ANGULAR_PANELS.has(type)) {
      this.legacyPanels++;
      this.legacyTypes.add(type);
    }

    const title = typeof json.title === "string" && json.title !== "" ? json.title : `panel ${String(json.id ?? index + 1)}`;
    return this.add({
      id,
      kind: "new",
      className: cls.className,
      customClass: cls.customClass,
      props,
      name: title,
      module,
      unit: id,
    });
  }

  /** A row, after its panels. */
  row(json: Json, path: string, children: Array<{ json: unknown; path: string }>, rowModule: string, ds: Resolution): string {
    const index = this.rowCount++;
    const id = `row:${index}`;
    const subject = `row "${String(json.title ?? "")}"`;
    const panels: DeclRef[] = [];
    for (const c of children) {
      const pid = this.panel(c.json, c.path, rowModule, ds);
      if (pid) panels.push(declRef(pid));
    }
    const props: Json = { title: typeof json.title === "string" ? json.title : "" };
    this.copyFields(json, ROW_FIELDS, ROW_DEFAULTS, props);
    if (ds !== undefined && ds !== "mixed") props.datasource = ds.value;
    if (typeof json.repeat === "string" && json.repeat !== "") {
      const v = this.variables.get(json.repeat);
      props.repeat = v ? declRef(v) : json.repeat;
    }
    if (panels.length > 0) props.panels = panels;
    const handled = new Set([...ROW_FIELDS, "type", "datasource", "repeat", "panels", "gridPos"]);
    for (const key of Object.keys(json)) {
      if (handled.has(key)) continue;
      const v = json[key];
      this.report.drop(`${path}${pointer(key)}`, subject, key, v === null || isDefault(ROW_DEFAULTS, key, v) ? undefined : NO_PROP);
    }
    return this.add({ id, kind: "new", className: "Row", props, name: `${String(json.title ?? "")} row`, module: rowModule, unit: id });
  }

  /** The dashboard's panels list: top-level panels and rows, each row with the panels under it. */
  items(): DeclRef[] {
    const panels = Array.isArray(this.d.panels) ? this.d.panels : [];
    const out: DeclRef[] = [];
    let i = 0;
    const topModule = () => this.module("panels", "panels", "Panels above the first row");
    while (i < panels.length) {
      const p = panels[i];
      const path = pointer("panels", i);
      if (isObject(p) && p.type === "row") {
        const title = typeof p.title === "string" ? p.title : "";
        const rowModule = this.module(`row:${i}`, `row-${slugUid(title || `row ${i}`)}`, `The row "${title}" and its panels`);
        const ds = this.resolveDatasource(p.datasource, `${path}/datasource`, `row "${title}"`);
        const children: Array<{ json: unknown; path: string }> = [];
        const nested = Array.isArray(p.panels) ? p.panels : [];
        if (p.collapsed === true) {
          nested.forEach((c, j) => children.push({ json: c, path: `${path}/panels/${j}` }));
          i++;
        } else {
          if (nested.length > 0) {
            this.report.drop(`${path}/panels`, `row "${title}"`, "panels", "(the row is expanded, so Grafana shows the panels after it instead)");
          }
          i++;
          while (i < panels.length && !(isObject(panels[i]) && (panels[i] as Json).type === "row")) {
            children.push({ json: panels[i], path: pointer("panels", i) });
            i++;
          }
        }
        out.push(declRef(this.row(p, path, children, rowModule, ds)));
      } else {
        const pid = this.panel(p, path, topModule(), undefined);
        if (pid) out.push(declRef(pid));
        i++;
      }
    }
    return out;
  }

  // ── the dashboard ───────────────────────────────────────────────

  convert(): Plan {
    const d = this.d;
    for (const key of ["__requires", "__elements"]) {
      if (!(key in d)) continue;
      const v = d[key];
      const empty = v === null || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);
      if (empty) this.report.drop(pointer(key), "dashboard", key);
      else if (key === "__requires") this.report.drop(pointer(key), "dashboard", key, "(the list of plugins it was exported with; Grafana does not need it to load the dashboard)");
      else this.report.drop(pointer(key), "dashboard", key, "(the library panels exported with it; library panels are not carried yet)");
    }
    if ("__inputs" in d) this.report.drop(pointer("__inputs"), "dashboard", "__inputs");

    const templating = isObject(d.templating) && Array.isArray(d.templating.list) ? d.templating.list : [];
    const templateNames = new Set(templating.filter(isObject).map((v) => String(v.name)));
    const inputIds = this.inputVariables(templateNames);
    // Datasource variables first: other variables and panels refer to them.
    const order = templating.map((v, i) => ({ v, i })).sort((a, b) => Number(isObject(b.v) && b.v.type === "datasource") - Number(isObject(a.v) && a.v.type === "datasource"));
    const varIds = new Map<number, string>();
    for (const { v, i } of order) {
      const id = this.variable(v, i);
      if (id) varIds.set(i, id);
    }
    const variableRefs = [...inputIds, ...templating.map((_, i) => varIds.get(i)).filter((x): x is string => x !== undefined)].map(declRef);

    const panelRefs = this.items();
    this.settleExternals();
    if (this.legacyPanels > 0) {
      this.report.warn(
        `${this.legacyPanels} ${this.legacyPanels === 1 ? "panel is an AngularJS panel" : "panels are AngularJS panels"} (${[...this.legacyTypes].join(", ")}) ` +
          "that keep their settings as top-level keys, which are not carried. Grafana converts these panels when it loads the dashboard; " +
          "to import them with their settings, load the dashboard in Grafana 11 or later, export it again, and import that export.",
      );
    }

    const props: Json = {};
    for (const key of DASHBOARD_FIELDS) {
      if (!(key in d)) continue;
      const v = d[key];
      if (v === null || v === undefined || (key !== "title" && key !== "uid" && key !== "timezone" && isDefault(DASHBOARD_DEFAULTS, key, v))) continue;
      if (key === "refresh" && v === false) continue;
      props[key] = v;
    }
    if (typeof props.title !== "string") props.title = "";
    if (typeof d.uid !== "string" || d.uid === "") {
      props.uid = slugUid(String(props.title) || "dashboard");
      this.report.replace(pointer("uid"), props.uid, "dashboard", "uid", `is missing, so the dashboard is given the uid "${String(props.uid)}", from its title`);
    }
    // chant writes "browser" for a dashboard without a timezone; Grafana reads a missing one as "", the viewer's preference.
    if (!("timezone" in d) || d.timezone === null) props.timezone = "";
    if (typeof d.graphTooltip === "number" && d.graphTooltip !== 0) {
      const tooltip = GRAPH_TOOLTIP[d.graphTooltip];
      if (tooltip) props.graphTooltip = tooltip;
      else this.report.drop(pointer("graphTooltip"), "dashboard", "graphTooltip", `(${d.graphTooltip} is not a value Grafana has)`);
    }
    if (typeof d.schemaVersion === "number") {
      if (d.schemaVersion !== DASHBOARD_SCHEMA_VERSION) props.schemaVersion = d.schemaVersion;
    } else {
      this.report.replace(pointer("schemaVersion"), DASHBOARD_SCHEMA_VERSION, "dashboard", "schemaVersion", `is missing, so the dashboard is written at ${DASHBOARD_SCHEMA_VERSION}`);
    }
    if (variableRefs.length > 0) props.variables = variableRefs;
    if (panelRefs.length > 0) props.panels = panelRefs;

    // Annotations: the built-in one is what Grafana adds anyway; any other is not carried yet.
    const annotations = isObject(d.annotations) && Array.isArray(d.annotations.list) ? d.annotations.list : [];
    const others = annotations.filter((a) => !isBuiltinAnnotation(a));
    if (others.length > 0) {
      const names = others.map((a) => (isObject(a) && typeof a.name === "string" ? `"${a.name}"` : "(unnamed)"));
      this.report.drop(
        pointer("annotations"),
        "dashboard",
        "",
        `has ${others.length === 1 ? "the annotation" : "the annotations"} ${list(names)}, which ${others.length === 1 ? "is" : "are"} not carried: Dashboard has no annotations yet (#2953)`,
      );
    }

    const handled = new Set([
      ...DASHBOARD_FIELDS,
      ...BOOKKEEPING_KEYS,
      "panels",
      "templating",
      "annotations",
      "graphTooltip",
      "schemaVersion",
      "__inputs",
      "__requires",
      "__elements",
    ]);
    for (const key of Object.keys(d)) {
      if (handled.has(key)) continue;
      const v = d[key];
      this.report.drop(pointer(key), "dashboard", key, v === null || isDefault(DASHBOARD_DEFAULTS, key, v) ? undefined : NO_PROP);
    }

    this.module("dashboard", "dashboard", `The dashboard "${String(props.title)}"`);
    this.add({ id: "dashboard", kind: "new", className: "Dashboard", props, name: String(props.title) || "dashboard", module: "dashboard" });

    const order2 = ["plugins", "datasources", "variables", "panels"];
    const modules = [...this.modules.values()].sort((a, b) => rank(a.key, order2) - rank(b.key, order2));
    return {
      directory: slugUid(typeof d.uid === "string" && d.uid !== "" ? d.uid : String(props.title) || "dashboard"),
      modules,
      declarations: this.declarations,
      customClasses: [...this.customClasses.values()],
      exports: [...this.externals, "dashboard"],
    };
  }
}

const ANGULAR_PANELS = new Set(["graph", "singlestat", "table-old", "grafana-singlestat-panel", "grafana-piechart-panel", "grafana-worldmap-panel"]);

function rank(key: string, order: string[]): number {
  const i = order.indexOf(key);
  if (i !== -1) return i;
  return key === "dashboard" ? order.length + 2 : order.length + 1;
}

function substituteStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => substituteStrings(v, from, to));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteStrings(v, from, to)]));
  return value;
}

/** The logical id (export name) of a dashboard's IR resource. */
function logicalIdFor(title: string): string {
  const w = words(title);
  const id = w.map((x, i) => (i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  return id === "" || /^[0-9]/.test(id) ? `dashboard${pascal(id)}` : id;
}

/** `__inputs` constants filled in, as Grafana's import dialog does: the dashboard with them substituted. */
function substituteConstants(dashboard: Json, report: Report): Json {
  let d = dashboard;
  const inputs = Array.isArray(d.__inputs) ? d.__inputs : [];
  for (const input of inputs) {
    if (!isObject(input) || input.type !== "constant" || typeof input.name !== "string") continue;
    const value = typeof input.value === "string" ? input.value : "";
    for (const from of [`\${${input.name}}`, `$${input.name}`]) {
      report.edit({ op: "substitute", from, to: value });
      d = substituteStrings(d, from, value) as Json;
    }
    report.warn(`__inputs: the constant ${input.name} is written as its value ${JSON.stringify(value)}, the value Grafana's import dialog fills in`);
  }
  return d;
}

/** Plan one classic dashboard. */
export function planDashboard(dashboard: Json): { plan: Plan; edits: ImportEdit[]; warnings: string[] } {
  const report = new Report();
  const plan = new DashboardConverter(substituteConstants(dashboard, report), report).convert();
  return { plan, edits: report.edits, warnings: report.warnings() };
}

// ── provisioning files ─────────────────────────────────────────────

const DATASOURCE_FIELDS = [
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

/** Plan a datasource provisioning file: one `Datasource` per entry. */
export function planDatasourceProvisioning(doc: Json): { plan: Plan; warnings: string[] } {
  const report = new Report();
  const declarations: Declaration[] = [];
  const list = Array.isArray(doc.datasources) ? doc.datasources : [];
  list.forEach((ds, i) => {
    if (!isObject(ds) || typeof ds.name !== "string" || typeof ds.type !== "string") {
      report.drop(pointer("datasources", i), "datasources", `entry ${i}`, "(it has no name or type)");
      return;
    }
    const props: Json = {};
    for (const key of DATASOURCE_FIELDS) if (ds[key] !== undefined && ds[key] !== null) props[key] = ds[key];
    for (const key of Object.keys(ds)) {
      if (!DATASOURCE_FIELDS.includes(key)) report.drop(pointer("datasources", i, key), `datasource "${ds.name}"`, key, NO_PROP);
    }
    declarations.push({ id: `datasource:${i}`, kind: "new", className: "Datasource", props, name: ds.name, module: "datasources" });
  });
  for (const key of Object.keys(doc)) {
    if (key === "apiVersion" || key === "datasources") continue;
    report.drop(pointer(key), "the provisioning file", key, "(chant writes datasources only; prune and deleteDatasources are #2953)");
  }
  return {
    plan: {
      directory: "",
      modules: [{ key: "datasources", file: "datasources", summary: "Datasources, from a Grafana datasource provisioning file" }],
      declarations,
      customClasses: [],
      exports: declarations.map((d) => d.id),
    },
    warnings: report.warnings(),
  };
}

const PROVIDER_FIELDS = ["name", "orgId", "folder", "folderUid", "disableDeletion", "allowUiUpdates", "updateIntervalSeconds"];

/** Plan a dashboard provisioning file: one `DashboardProvider` per file provider. */
export function planDashboardProvisioning(doc: Json): { plan: Plan; warnings: string[] } {
  const report = new Report();
  const declarations: Declaration[] = [];
  const list = Array.isArray(doc.providers) ? doc.providers : [];
  list.forEach((p, i) => {
    if (!isObject(p) || typeof p.name !== "string") {
      report.drop(pointer("providers", i), "providers", `entry ${i}`, "(it has no name)");
      return;
    }
    const subject = `provider "${p.name}"`;
    if (p.type !== undefined && p.type !== "file") {
      report.drop(pointer("providers", i), subject, "", `is of type ${String(p.type)}; chant writes file providers only, so it is left out`);
      return;
    }
    const props: Json = {};
    for (const key of PROVIDER_FIELDS) if (p[key] !== undefined && p[key] !== null) props[key] = p[key];
    const options = isObject(p.options) ? p.options : {};
    if (options.path !== undefined) props.path = options.path;
    if (options.foldersFromFilesStructure !== undefined) props.foldersFromFilesStructure = options.foldersFromFilesStructure;
    for (const key of Object.keys(options)) {
      if (key !== "path" && key !== "foldersFromFilesStructure") report.drop(pointer("providers", i, "options", key), subject, `options.${key}`, NO_PROP);
    }
    for (const key of Object.keys(p)) {
      if (!PROVIDER_FIELDS.includes(key) && key !== "type" && key !== "options") report.drop(pointer("providers", i, key), subject, key, NO_PROP);
    }
    declarations.push({ id: `provider:${i}`, kind: "new", className: "DashboardProvider", props, name: `${p.name} provider`, module: "providers" });
  });
  return {
    plan: {
      directory: "",
      modules: [{ key: "providers", file: "dashboard-providers", summary: "Dashboard providers, from a Grafana dashboard provisioning file" }],
      declarations,
      customClasses: [],
      exports: declarations.map((d) => d.id),
    },
    warnings: report.warnings(),
  };
}

// ── the parser ─────────────────────────────────────────────────────

/** The dashboard inside a resource or API response, and where it came from. */
export function unwrapDashboard(data: Json): Json {
  if (looksLikeDashboardApiResponse(data)) return data.dashboard;
  if (looksLikeDashboardResource(data)) {
    const spec = { ...data.spec };
    const meta = isObject((data as Json).metadata) ? ((data as Json).metadata as Json) : {};
    if ((typeof spec.uid !== "string" || spec.uid === "") && typeof meta.name === "string") spec.uid = meta.name;
    return spec;
  }
  return data;
}

function parseDocument(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Provisioning files are YAML.
  }
  return jsYaml.load(content, { schema: jsYaml.CORE_SCHEMA });
}

function resource(logicalId: string, type: string, plan: Plan, metadata?: Json): ResourceIR {
  const properties: PlanResourceProperties = { plan };
  return { logicalId, type, properties: properties as unknown as Json, ...(metadata ? { metadata } : {}) };
}

/** Parse dashboard JSON or a provisioning file into IR. */
export function parseGrafana(content: string): TemplateIR {
  const data = content.trim() === "" ? undefined : parseDocument(content);
  if (!isObject(data)) {
    throw new Error("expected Grafana dashboard JSON or a provisioning file, as a JSON or YAML object");
  }

  if (looksLikeV2Dashboard(data)) {
    const version = looksLikeDashboardResource(data) ? ` (${data.apiVersion})` : "";
    return {
      resources: [],
      parameters: [],
      warnings: [
        `This is a v2 dashboard${version}. chant imports classic (v1) dashboard JSON; reading v2 is not supported yet (#2947). ` +
          "In Grafana, export it with Export > Export as JSON and the Classic model, and import that. Nothing was imported.",
      ],
    };
  }

  const dashboard: unknown = unwrapDashboard(data);
  if (looksLikeLegacyRowsDashboard(dashboard)) {
    return {
      resources: [],
      parameters: [],
      warnings: [
        `This dashboard was saved before Grafana 5.0 (schemaVersion ${String(dashboard.schemaVersion)}): its panels are inside a top-level "rows" list, ` +
          "which Grafana converts to a grid when it loads it and chant does not read. Import it into Grafana 11 or later, export it again, " +
          "and import that export. Nothing was imported.",
      ],
    };
  }

  if (looksLikeDashboard(dashboard)) {
    const { plan, edits, warnings } = planDashboard(dashboard);
    const metadata: DashboardResourceMetadata = { source: dashboard, edits };
    const title = typeof dashboard.title === "string" ? dashboard.title : "dashboard";
    return {
      resources: [resource(logicalIdFor(title), DASHBOARD_RESOURCE_TYPE, plan, metadata as unknown as Json)],
      parameters: [],
      warnings,
    };
  }

  if (looksLikeDatasourceProvisioning(data)) {
    const { plan, warnings } = planDatasourceProvisioning(data as unknown as Json);
    return { resources: [resource("datasources", PROVISIONING_RESOURCE_TYPE, plan)], parameters: [], warnings };
  }

  if (looksLikeDashboardProvisioning(data)) {
    const { plan, warnings } = planDashboardProvisioning(data as unknown as Json);
    return { resources: [resource("dashboardProviders", PROVISIONING_RESOURCE_TYPE, plan)], parameters: [], warnings };
  }

  throw new Error("this is not Grafana dashboard JSON (no panels list) or a provisioning file (no datasources or providers list)");
}

/** The Grafana dashboard parser `chant import` runs. */
export class GrafanaParser implements TemplateParser {
  parse(content: string): TemplateIR {
    return parseGrafana(content);
  }
}
