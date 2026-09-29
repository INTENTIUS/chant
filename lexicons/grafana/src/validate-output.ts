/**
 * The checks behind GRAF101-GRAF109, GRAF111-GRAF114 and GRAF115, as plain
 * functions over built Grafana output: dashboard JSON documents, provisioned
 * datasources, dashboard providers and alerting provisioning files (the
 * alerting checks are in `validate-alerting.ts`). The
 * post-synth checks run them over a build; anything else holding the same
 * JSON (a test, another lexicon embedding dashboards) can call them directly.
 *
 * Checks that join a dashboard against datasources (GRAF101, GRAF102) only
 * see the datasources passed in: the ones provisioned and the ones declared
 * with `ExternalDatasource`. In a build that is the build root being built
 * (chant #1939). With none declared they warn that references cannot be
 * checked; a datasource that exists in Grafana but is not declared looks
 * undeclared, so declare it with `ExternalDatasource`.
 */

import type { ExternalDatasourceRecord, ProvisionedDatasource } from "./build";
import { DASHBOARDS_DIR, GRID_COLUMNS } from "./build";
import {
  datasourceUses,
  describePanel,
  knownDatasources,
  panelsOf,
  variableReferences,
  variablesOf,
  type DatasourceRefJson,
  type KnownDatasource,
} from "./datasource-refs";
import { isBuiltinVariable } from "./variables";
import { isValidUid } from "./util";
import { validateDashboardSchema } from "./schema-validate";
import { checkGrafanaPromql, prometheusQueries } from "./promql-check";
import { checkAlertingIdentity, checkNotificationRefs, checkRuleDatasources, checkRulePromql, checkRuleQueries, type AlertingDoc } from "./validate-alerting";
import { closestGrafanaUnit, isGrafanaUnit } from "./spec/units";

export type GrafanaIssueCode =
  | "GRAF101"
  | "GRAF102"
  | "GRAF103"
  | "GRAF104"
  | "GRAF105"
  | "GRAF106"
  | "GRAF107"
  | "GRAF108"
  | "GRAF109"
  | "GRAF111"
  | "GRAF112"
  | "GRAF113"
  | "GRAF114"
  | "GRAF115";

export interface GrafanaIssue {
  code: GrafanaIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The dashboard uid or datasource name the issue is about. */
  entity?: string;
}

export interface DashboardDoc {
  /** Where it came from, e.g. its output file. */
  source?: string;
  json: Record<string, unknown>;
}

export interface GrafanaArtifacts {
  dashboards: DashboardDoc[];
  /** Datasources the build provisions. */
  datasources: ProvisionedDatasource[];
  /** Datasources the build references but does not provision (`ExternalDatasource`). */
  externalDatasources?: ExternalDatasourceRecord[];
  /** Entries of `providers:` in dashboard provisioning files, as written: any field may be missing. */
  providers?: Array<Record<string, unknown>>;
  /** Alerting provisioning files (rule groups, contact points, policies, mute timings, templates). */
  alerting?: AlertingDoc[];
}

export type { AlertingDoc };

export { variableReferences };

type Json = Record<string, unknown>;

function dashName(d: Json): string {
  return `Dashboard "${String(d.title ?? d.uid ?? "?")}"`;
}

function isVariableUid(uid: string | undefined): boolean {
  return typeof uid === "string" && uid.includes("$");
}

function stringsIn(value: unknown, skip: ReadonlySet<string>, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, skip, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!skip.has(k)) stringsIn(v, skip, out);
  }
  return out;
}

const TARGET_SKIP = new Set(["refId", "datasource"]);

/** Every datasource ref a panel or row writes itself, with where it is written. */
function panelRefs(panel: Json): Array<{ ref: DatasourceRefJson; where: string }> {
  const out: Array<{ ref: DatasourceRefJson; where: string }> = [];
  const panelRef = panel.datasource as DatasourceRefJson | undefined;
  if (panelRef && typeof panelRef === "object") out.push({ ref: panelRef, where: describePanel(panel) });
  const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
  for (const t of targets) {
    const r = t?.datasource as DatasourceRefJson | undefined;
    if (r && typeof r === "object") out.push({ ref: r, where: `${describePanel(panel)} query ${String(t.refId ?? "?")}` });
  }
  return out;
}

/** The datasources a set of artifacts knows by uid: provisioned and external. */
export function knownDatasourcesOf(a: GrafanaArtifacts): Map<string, KnownDatasource> {
  return knownDatasources(a.datasources, a.externalDatasources ?? []);
}

function listUids(known: ReadonlyMap<string, KnownDatasource>): string {
  return [...known.keys()].map((k) => `"${k}"`).join(", ");
}

// ── GRAF101, GRAF102: datasource references ─────────────────────

export function checkDatasourceRefs(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  const known = knownDatasourcesOf(a);
  const types = new Set([...known.values()].map((k) => k.type));
  for (const { json: d } of a.dashboards) {
    const uid = String(d.uid ?? "");
    const push = (code: GrafanaIssueCode, severity: GrafanaIssue["severity"], message: string) =>
      issues.push({ code, severity, message: `${dashName(d)} ${message}`, entity: uid });

    for (const { panel } of panelsOf(d)) {
      if (panel.type === "row") continue;
      const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
      if (targets.length > 0 && !panel.datasource && targets.every((t) => !t?.datasource)) {
        push("GRAF101", "warning", `${describePanel(panel)} has queries but no datasource; Grafana will send them to whichever datasource is its default.`);
      }
    }

    const uses = datasourceUses(d, known).filter((u) => u.ref !== undefined);
    const dsVariables = variablesOf(d).filter((v) => v.type === "datasource" && typeof v.query === "string" && v.query);

    // Nothing declared: the references can't be checked. Say so once per dashboard rather than staying silent.
    if (known.size === 0) {
      const uids = [...new Set(uses.flatMap((u) => (u.resolved.kind === "undeclared" ? [u.resolved.uid] : [])))];
      const plugins = [...new Set(dsVariables.map((v) => String(v.query)))];
      const what = [
        ...(uids.length > 0 ? [`datasource uid${uids.length > 1 ? "s" : ""} ${uids.map((u) => `"${u}"`).join(", ")}`] : []),
        ...(plugins.length > 0 ? [`datasource variables of type ${plugins.join(", ")}`] : []),
      ];
      if (what.length > 0) {
        const them = uids.length + plugins.length > 1 ? "them" : "it";
        push(
          "GRAF101",
          "warning",
          `uses ${what.join(" and ")}, but the build declares no datasource, so GRAF101 and GRAF102 cannot check ${them}. Declare a Datasource to provision one, or an ExternalDatasource for one that already exists in Grafana.`,
        );
      }
    }

    for (const { ref, where, resolved } of uses) {
      if (resolved.kind === "variable") {
        const v = variablesOf(d).find((x) => x.name === resolved.variable);
        if (v && v.type === "datasource" && ref!.type && v.query && v.query !== ref!.type) {
          push("GRAF102", "error", `${where} expects a ${ref!.type} datasource, but variable "${resolved.variable}" chooses among ${String(v.query)} datasources.`);
        }
      } else if (resolved.kind === "undeclared" && known.size > 0) {
        push(
          "GRAF101",
          "error",
          `${where} uses datasource uid "${resolved.uid}"${ref!.type ? ` (${ref!.type})` : ""}, which no declared Datasource or ExternalDatasource has. Declared: ${listUids(known)}.`,
        );
      } else if (resolved.kind === "declared" && ref!.type && ref!.type !== resolved.type) {
        const ds = resolved.datasource;
        push("GRAF102", "error", `${where} sends a ${ref!.type} query to ${ds.external ? "external " : ""}datasource "${ds.name ?? ds.uid}", which is ${ds.type}.`);
      }
    }

    // A datasource variable offers the datasources of its plugin type; with none declared it has nothing to choose.
    if (known.size > 0) {
      for (const v of dsVariables) {
        if (types.has(String(v.query))) continue;
        push(
          "GRAF101",
          "error",
          `variable "${String(v.name)}" chooses among ${String(v.query)} datasources, but no declared Datasource or ExternalDatasource is of type ${String(v.query)}. Declared types: ${[...types].join(", ")}.`,
        );
      }
    }
  }
  return issues;
}

// ── GRAF103: variables ──────────────────────────────────────────

export function checkVariables(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  for (const { json: d } of a.dashboards) {
    const uid = String(d.uid ?? "");
    const declared = new Set(variablesOf(d).map((v) => String(v.name)));
    const report = (name: string, where: string) => {
      if (declared.has(name) || isBuiltinVariable(name)) return;
      issues.push({
        code: "GRAF103",
        severity: "error",
        message: `${dashName(d)} ${where} uses $${name}, which is not one of its variables${declared.size > 0 ? ` (${[...declared].map((n) => `$${n}`).join(", ")})` : ""}.`,
        entity: uid,
      });
    };
    for (const { panel } of panelsOf(d)) {
      const where = panel.type === "row" ? `row "${String(panel.title ?? "")}"` : describePanel(panel);
      if (typeof panel.repeat === "string" && panel.repeat) report(panel.repeat, `${where} repeat`);
      if (typeof panel.title === "string") for (const n of new Set(variableReferences(panel.title))) report(n, `${where} title`);
      for (const { ref, where: w } of panelRefs(panel)) {
        if (isVariableUid(ref.uid)) for (const n of variableReferences(ref.uid!)) report(n, `${w} datasource`);
      }
      const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
      for (const t of targets) {
        const names = new Set(stringsIn(t, TARGET_SKIP).flatMap(variableReferences));
        for (const n of names) report(n, `${where} query ${String(t?.refId ?? "?")}`);
      }
    }
    for (const v of variablesOf(d)) {
      if (v.type !== "query") continue;
      const names = new Set(stringsIn(v.query, new Set()).flatMap(variableReferences));
      for (const n of names) if (n !== v.name) report(n, `variable "${String(v.name)}" query`);
    }
  }
  return issues;
}

// ── GRAF104: duplicates ─────────────────────────────────────────

function dupes<T>(items: T[], key: (t: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, n]) => n > 1));
}

export function checkDuplicates(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  const push = (message: string, entity?: string) => issues.push({ code: "GRAF104", severity: "error", message, entity });
  for (const [uid, n] of dupes(a.dashboards, (d) => (typeof d.json.uid === "string" ? d.json.uid : undefined))) {
    push(`${n} dashboards share the uid "${uid}"; Grafana keeps one of them.`, uid);
  }
  const allUids = [...a.datasources.map((d) => d.uid), ...(a.externalDatasources ?? []).map((d) => d.uid)];
  for (const [uid, n] of dupes(allUids, (u) => u)) push(`${n} datasources share the uid "${uid}".`, uid);
  for (const [name, n] of dupes(a.datasources, (d) => d.name)) push(`${n} datasources share the name "${name}"; Grafana needs names to be unique.`, name);
  for (const { json: d } of a.dashboards) {
    const uid = String(d.uid ?? "");
    const panels = panelsOf(d).map((p) => p.panel);
    for (const [id, n] of dupes(panels, (p) => (typeof p.id === "number" ? String(p.id) : undefined))) {
      push(`${dashName(d)} has ${n} panels with id ${id}.`, uid);
    }
    for (const [name, n] of dupes(variablesOf(d), (v) => (typeof v.name === "string" ? v.name : undefined))) {
      push(`${dashName(d)} declares the variable "${name}" ${n} times.`, uid);
    }
    for (const p of panels) {
      const targets = Array.isArray(p.targets) ? (p.targets as Json[]) : [];
      for (const [refId, n] of dupes(targets, (t) => (typeof t?.refId === "string" ? t.refId : undefined))) {
        push(`${dashName(d)} ${describePanel(p)} has ${n} queries with refId "${refId}".`, uid);
      }
    }
  }
  return issues;
}

// ── GRAF105: grid ───────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(panel: Json): Box | undefined {
  const g = panel.gridPos as Partial<Box> | undefined;
  if (!g || typeof g !== "object") return undefined;
  if ([g.x, g.y, g.w, g.h].some((v) => typeof v !== "number")) return undefined;
  return g as Box;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function checkGrid(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  for (const { json: d } of a.dashboards) {
    const uid = String(d.uid ?? "");
    const groups = new Map<string, Array<{ panel: Json; box: Box }>>();
    for (const { panel, group } of panelsOf(d)) {
      const box = boxOf(panel);
      if (!box) continue;
      if (box.x < 0 || box.y < 0 || box.w < 1 || box.h < 1 || box.x + box.w > GRID_COLUMNS) {
        issues.push({
          code: "GRAF105",
          severity: "error",
          message: `${dashName(d)} ${describePanel(panel)} at x=${box.x} y=${box.y} w=${box.w} h=${box.h} does not fit Grafana's ${GRID_COLUMNS}-column grid.`,
          entity: uid,
        });
      }
      groups.set(group, [...(groups.get(group) ?? []), { panel, box }]);
    }
    for (const members of groups.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          if (!overlaps(members[i].box, members[j].box)) continue;
          issues.push({
            code: "GRAF105",
            severity: "warning",
            message: `${dashName(d)} ${describePanel(members[i].panel)} overlaps ${describePanel(members[j].panel)}; Grafana will move one of them.`,
            entity: uid,
          });
        }
      }
    }
  }
  return issues;
}

// ── GRAF106: uids and titles Grafana rejects ────────────────────

export function checkIdentity(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  for (const { json: d } of a.dashboards) {
    const uid = d.uid;
    if (typeof uid !== "string" || !isValidUid(uid)) {
      issues.push({
        code: "GRAF106",
        severity: "error",
        message: `${dashName(d)} has uid ${JSON.stringify(uid)}; Grafana accepts 1-40 letters, digits, "-" and "_".`,
        entity: typeof uid === "string" ? uid : undefined,
      });
    }
    if (typeof d.title !== "string" || d.title.trim() === "") {
      issues.push({ code: "GRAF106", severity: "error", message: `Dashboard ${JSON.stringify(uid)} has no title; Grafana refuses to save it.`, entity: String(uid) });
    }
  }
  for (const ds of a.datasources) {
    if (!isValidUid(ds.uid)) {
      issues.push({
        code: "GRAF106",
        severity: "error",
        message: `Datasource "${ds.name}" has uid "${ds.uid}"; Grafana accepts 1-40 letters, digits, "-" and "_".`,
        entity: ds.name,
      });
    }
  }
  for (const ds of a.externalDatasources ?? []) {
    if (!isValidUid(ds.uid)) {
      issues.push({
        code: "GRAF106",
        severity: "error",
        message: `ExternalDatasource "${ds.name ?? ds.uid}" has uid "${ds.uid}"; Grafana accepts 1-40 letters, digits, "-" and "_".`,
        entity: ds.name ?? ds.uid,
      });
    }
  }
  return issues;
}

// ── GRAF107: the pinned schemas ─────────────────────────────────

/**
 * A value the pinned schemas (with the correction overlay) do not allow is
 * an error; a key they do not know is a warning, since newer Grafana
 * versions add keys the pin has not caught up with.
 */
export function checkSchema(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  for (const { json: d } of a.dashboards) {
    for (const p of validateDashboardSchema(d)) {
      issues.push({
        code: "GRAF107",
        severity: p.severity,
        message: `${dashName(d)} ${p.path}: ${p.message} (Grafana schema).`,
        entity: String(d.uid ?? ""),
      });
    }
  }
  return issues;
}

// ── GRAF108: PromQL syntax ──────────────────────────────────────

/**
 * Each panel query, query variable and alert rule query that reaches a
 * Prometheus datasource is parsed as PromQL, with its template variables replaced by placeholders
 * first (see `promql-check.ts`). A query whose datasource can't be told is
 * not parsed.
 */
export function checkPromqlSyntax(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  const known = knownDatasourcesOf(a);
  for (const { json: d } of a.dashboards) {
    for (const { where, expr } of prometheusQueries(d, known)) {
      const checked = checkGrafanaPromql(expr);
      if (checked.ok) continue;
      issues.push({ code: "GRAF108", severity: "error", message: `${dashName(d)} ${where} is not valid PromQL: ${checked.message}.`, entity: String(d.uid ?? "") });
    }
  }
  issues.push(...checkRulePromql(a.alerting ?? [], known));
  return issues;
}

// ── GRAF115: units ──────────────────────────────────────────────

/** Every unit a panel sets, with where: field defaults, `unit` overrides, heatmap axes and cells, and a legacy graph panel's y-axes. */
export function panelUnits(panel: Json): Array<{ where: string; unit: string }> {
  const out: Array<{ where: string; unit: string }> = [];
  const add = (where: string, unit: unknown) => {
    if (typeof unit === "string") out.push({ where, unit });
  };
  const fieldConfig = panel.fieldConfig as Json | undefined;
  add("fieldConfig.defaults.unit", (fieldConfig?.defaults as Json | undefined)?.unit);
  const overrides = Array.isArray(fieldConfig?.overrides) ? (fieldConfig.overrides as Json[]) : [];
  overrides.forEach((o, i) => {
    const props = Array.isArray(o?.properties) ? (o.properties as Json[]) : [];
    props.forEach((p, j) => {
      if (p?.id === "unit") add(`fieldConfig.overrides[${i}].properties[${j}]`, p.value);
    });
  });
  const options = panel.options as Json | undefined;
  add("options.yAxis.unit", (options?.yAxis as Json | undefined)?.unit);
  add("options.cellValues.unit", (options?.cellValues as Json | undefined)?.unit);
  if (Array.isArray(panel.yaxes)) (panel.yaxes as Json[]).forEach((y, i) => add(`yaxes[${i}].format`, y?.format));
  return out;
}

/**
 * A unit Grafana doesn't register (at v13.2.2) and that isn't a custom
 * `<kind>:` unit is shown as a literal suffix, so `"byte"` renders `5 byte`.
 * A warning: it renders, just not as meant.
 */
export function checkUnits(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  for (const { json: d } of a.dashboards) {
    const panels: Array<{ panel: Json; label: string }> = panelsOf(d).map(({ panel }) => ({ panel, label: describePanel(panel) }));
    const elements = d.__elements;
    if (elements && typeof elements === "object" && !Array.isArray(elements)) {
      for (const [key, element] of Object.entries(elements as Json)) {
        const model = element && typeof element === "object" ? (element as Json).model : undefined;
        if (model && typeof model === "object" && !Array.isArray(model)) panels.push({ panel: model as Json, label: `library panel "${key}"` });
      }
    }
    for (const { panel, label } of panels) {
      if (panel.type === "row") continue;
      for (const { where, unit } of panelUnits(panel)) {
        if (isGrafanaUnit(unit)) continue;
        const guess = closestGrafanaUnit(unit);
        const hint = guess ? `Did you mean "${guess}"? ` : "";
        issues.push({
          code: "GRAF115",
          severity: "warning",
          message: `${dashName(d)} ${label} ${where}: unit "${unit}" is not one Grafana knows, so it is shown as a literal suffix. ${hint}For a custom unit write "suffix:${unit}" (or prefix:, si:, count:, currency:, time:).`,
          entity: String(d.uid ?? ""),
        });
      }
    }
  }
  return issues;
}

// ── GRAF109: where dashboard provisioning puts dashboards ───────

/** Grafana's default `[folder] max_nested_folder_depth`, and the most it can be raised to. */
const DEFAULT_FOLDER_DEPTH = 4;
const MAX_FOLDER_DEPTH = 7;

/** The folder levels a dashboard file sits in under `dashboards/`, e.g. `["Platform", "Kubernetes"]`. */
function folderLevels(source: string | undefined): string[] {
  if (!source?.startsWith(`${DASHBOARDS_DIR}/`)) return [];
  return source.slice(DASHBOARDS_DIR.length + 1).split("/").slice(0, -1);
}

interface ProviderView {
  name: string;
  orgId: number;
  path: string;
  folder: string;
  folderUid: string;
  fromFiles: boolean;
}

function providerView(p: Record<string, unknown>): ProviderView {
  const options = (p.options && typeof p.options === "object" ? p.options : {}) as Json;
  const path = typeof options.path === "string" ? options.path : typeof options.folder === "string" ? options.folder : "";
  return {
    name: typeof p.name === "string" ? p.name : "?",
    orgId: typeof p.orgId === "number" && p.orgId !== 0 ? p.orgId : 1,
    path: path.replace(/\/+$/, "") || "/",
    folder: typeof p.folder === "string" ? p.folder : "",
    folderUid: typeof p.folderUid === "string" ? p.folderUid : "",
    fromFiles: options.foldersFromFilesStructure === true,
  };
}

/** Whether a provider reading `a` also reads `b`: Grafana walks a provider's path recursively. */
function contains(a: string, b: string): boolean {
  return a === b || a === "/" || b.startsWith(`${a}/`);
}

function listDashboards(ds: Array<{ d: Json; levels: string[] }>): string {
  const shown = ds.slice(0, 3).map(({ d, levels }) => `"${String(d.title ?? d.uid ?? "?")}" (${levels.join("/")})`);
  return ds.length > 3 ? `${shown.join(", ")} and ${ds.length - 3} more` : shown.join(", ");
}

export function checkProvisioning(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  const push = (severity: GrafanaIssue["severity"], message: string, entity?: string) => issues.push({ code: "GRAF109", severity, message, entity });
  const providers = (a.providers ?? []).map(providerView);
  const foldered = a.dashboards.map(({ source, json }) => ({ d: json, levels: folderLevels(source) })).filter((x) => x.levels.length > 0);

  // Two providers reading the same files, in the same org.
  for (let i = 0; i < providers.length; i++) {
    for (let j = i + 1; j < providers.length; j++) {
      const [p, q] = [providers[i], providers[j]];
      if (p.orgId !== q.orgId) continue;
      const shared = contains(p.path, q.path) ? q.path : contains(q.path, p.path) ? p.path : undefined;
      if (shared === undefined) continue;
      push(
        "error",
        `Dashboard providers "${p.name}" and "${q.name}" both load the dashboards under ${shared}. Grafana provisions each of them twice, then takes database writes away from both providers, so later changes to the files never reach Grafana. Give each provider its own path.`,
        q.name,
      );
    }
  }

  // A provider mapping directories to folders that also names a folder.
  for (const p of providers) {
    if (!p.fromFiles || (p.folder === "" && p.folderUid === "")) continue;
    if (p.folder !== "" && p.folderUid !== "") {
      push("error", `Dashboard provider "${p.name}" sets folder, folderUid and foldersFromFilesStructure; Grafana refuses to start it. Drop folder and folderUid, or foldersFromFilesStructure.`, p.name);
    } else {
      const which = p.folder !== "" ? `folder "${p.folder}"` : `folderUid "${p.folderUid}"`;
      push(
        "warning",
        `Dashboard provider "${p.name}" sets ${which} and foldersFromFilesStructure. Grafana files each dashboard by its directory and the top-level ones in General, so ${which} is not used${p.folderUid !== "" ? " (before Grafana 13.1 every directory resolves to that one folder uid instead)" : ""}. Drop one of the two.`,
        p.name,
      );
    }
  }

  // Dashboards with a folder that no provider maps from directories.
  if (foldered.length > 0 && providers.length > 0 && !providers.some((p) => p.fromFiles)) {
    const where = providers.map((p) => `"${p.name}" puts every dashboard in ${p.folder !== "" ? `folder "${p.folder}"` : p.folderUid !== "" ? `folder uid "${p.folderUid}"` : "General"}`).join("; ");
    push(
      "warning",
      `${foldered.length === 1 ? "A dashboard declares a folder" : `${foldered.length} dashboards declare a folder`}, ${listDashboards(foldered)}, but no dashboard provider sets foldersFromFilesStructure: ${where}. Set foldersFromFilesStructure: true on the provider (and drop its folder), or leave the dashboards' folder out.`,
    );
  }

  // Nested folders, where a provider does map directories to folders.
  if (providers.some((p) => p.fromFiles)) {
    for (const { d, levels } of foldered) {
      if (levels.length < 2) continue;
      const uid = String(d.uid ?? "");
      const path = levels.join("/");
      if (levels.length > MAX_FOLDER_DEPTH) {
        push("error", `${dashName(d)} is in folder "${path}", ${levels.length} levels deep; Grafana nests at most ${MAX_FOLDER_DEPTH}, and the provider stops with an error when it reaches it.`, uid);
      } else {
        const depth =
          levels.length > DEFAULT_FOLDER_DEPTH
            ? ` It is ${levels.length} levels deep, past Grafana's default max_nested_folder_depth of ${DEFAULT_FOLDER_DEPTH}: raise it in [folder], or the provider stops with an error when it reaches it.`
            : "";
        push(
          "warning",
          `${dashName(d)} is in nested folder "${path}". Grafana 13.1 and later create the folders inside one another; Grafana 12.4 and 13.0 use only the last level and put it in a top-level folder "${levels[levels.length - 1]}".${depth}`,
          uid,
        );
      }
    }
  }
  return issues;
}

const BY_CODE: Record<GrafanaIssueCode, (a: GrafanaArtifacts) => GrafanaIssue[]> = {
  GRAF101: (a) => checkDatasourceRefs(a).filter((i) => i.code === "GRAF101"),
  GRAF102: (a) => checkDatasourceRefs(a).filter((i) => i.code === "GRAF102"),
  GRAF103: checkVariables,
  GRAF104: checkDuplicates,
  GRAF105: checkGrid,
  GRAF106: checkIdentity,
  GRAF107: checkSchema,
  GRAF108: checkPromqlSyntax,
  GRAF109: checkProvisioning,
  GRAF111: (a) => checkRuleQueries(a.alerting ?? []),
  GRAF112: (a) => checkRuleDatasources(a.alerting ?? [], knownDatasourcesOf(a)),
  GRAF113: (a) => checkNotificationRefs(a.alerting ?? []),
  GRAF114: (a) => checkAlertingIdentity(a.alerting ?? []),
  GRAF115: checkUnits,
};

/** The issues one check finds. */
export function issuesFor(code: GrafanaIssueCode, a: GrafanaArtifacts): GrafanaIssue[] {
  return BY_CODE[code](a);
}

/** Every issue every check finds, in code order. */
export function validateGrafanaOutput(a: GrafanaArtifacts): GrafanaIssue[] {
  return (Object.keys(BY_CODE) as GrafanaIssueCode[]).flatMap((c) => issuesFor(c, a));
}
