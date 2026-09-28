/**
 * The checks behind GRAF101-GRAF107, as plain functions over built Grafana
 * output: dashboard JSON documents and provisioned datasources. The
 * post-synth checks run them over a build; anything else holding the same
 * JSON (a test, another lexicon embedding dashboards) can call them directly.
 *
 * Checks that join a dashboard against datasources (GRAF101, GRAF102) only
 * see the datasources passed in. In a build that is the build root being
 * built (chant #1939): with no datasource declared in it they report
 * nothing, and a datasource declared in another build root looks undeclared.
 */

import type { ProvisionedDatasource } from "./build";
import { GRID_COLUMNS } from "./build";
import { BUILTIN_DATASOURCE_UIDS } from "./datasource";
import { isBuiltinVariable } from "./variables";
import { isValidUid } from "./util";
import { validateDashboardSchema } from "./schema-validate";

export type GrafanaIssueCode = "GRAF101" | "GRAF102" | "GRAF103" | "GRAF104" | "GRAF105" | "GRAF106" | "GRAF107";

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
  datasources: ProvisionedDatasource[];
}

type Json = Record<string, unknown>;
interface Ref {
  type?: string;
  uid?: string;
}

interface PanelInfo {
  panel: Json;
  /** Panels inside a collapsed row are laid out in their own group. */
  group: string;
}

function panelsOf(dashboard: Json): PanelInfo[] {
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

function describePanel(panel: Json): string {
  const title = typeof panel.title === "string" && panel.title ? `"${panel.title}"` : "(untitled)";
  return `panel ${title} (id ${String(panel.id ?? "?")})`;
}

function dashName(d: Json): string {
  return `Dashboard "${String(d.title ?? d.uid ?? "?")}"`;
}

function variablesOf(d: Json): Json[] {
  const list = (d.templating as { list?: unknown } | undefined)?.list;
  return Array.isArray(list) ? (list as Json[]).filter((v) => v && typeof v === "object") : [];
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}|\[\[([A-Za-z_][A-Za-z0-9_]*)(?::[^\]]*)?\]\]|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every variable name referenced in a string. */
export function variableReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR_REF)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
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

/** Every datasource ref a panel makes, with where it is made. */
function panelRefs(panel: Json): Array<{ ref: Ref; where: string }> {
  const out: Array<{ ref: Ref; where: string }> = [];
  const panelRef = panel.datasource as Ref | undefined;
  if (panelRef && typeof panelRef === "object") out.push({ ref: panelRef, where: describePanel(panel) });
  const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
  for (const t of targets) {
    const r = t?.datasource as Ref | undefined;
    if (r && typeof r === "object") out.push({ ref: r, where: `${describePanel(panel)} query ${String(t.refId ?? "?")}` });
  }
  return out;
}

function isPseudoRef(ref: Ref): boolean {
  return ref.type === "datasource" || ref.type === "grafana" || (ref.uid !== undefined && BUILTIN_DATASOURCE_UIDS.has(ref.uid));
}

// ── GRAF101, GRAF102: datasource references ─────────────────────

export function checkDatasourceRefs(a: GrafanaArtifacts): GrafanaIssue[] {
  const issues: GrafanaIssue[] = [];
  if (a.datasources.length === 0) return issues; // declared elsewhere, or not at all: see #1939
  const byUid = new Map(a.datasources.map((d) => [d.uid, d]));
  for (const { json: d } of a.dashboards) {
    const uid = String(d.uid ?? "");
    const vars = new Map(variablesOf(d).map((v) => [String(v.name), v]));
    const refs: Array<{ ref: Ref; where: string }> = [];
    for (const { panel } of panelsOf(d)) {
      if (panel.type === "row") continue;
      refs.push(...panelRefs(panel));
      const targets = Array.isArray(panel.targets) ? (panel.targets as Json[]) : [];
      if (targets.length > 0 && !panel.datasource && targets.every((t) => !t?.datasource)) {
        issues.push({
          code: "GRAF101",
          severity: "warning",
          message: `${dashName(d)} ${describePanel(panel)} has queries but no datasource; Grafana will send them to whichever datasource is its default.`,
          entity: uid,
        });
      }
    }
    for (const v of vars.values()) {
      if (v.type === "query" && v.datasource && typeof v.datasource === "object") refs.push({ ref: v.datasource as Ref, where: `variable "${String(v.name)}"` });
    }
    for (const { ref, where } of refs) {
      if (isPseudoRef(ref) || ref.uid === undefined) continue;
      if (isVariableUid(ref.uid)) {
        const [name] = variableReferences(ref.uid);
        const v = name ? vars.get(name) : undefined;
        if (v && v.type === "datasource" && ref.type && v.query && v.query !== ref.type) {
          issues.push({
            code: "GRAF102",
            severity: "error",
            message: `${dashName(d)} ${where} expects a ${ref.type} datasource, but variable "${name}" chooses among ${String(v.query)} datasources.`,
            entity: uid,
          });
        }
        continue;
      }
      const declared = byUid.get(ref.uid);
      if (!declared) {
        issues.push({
          code: "GRAF101",
          severity: "error",
          message: `${dashName(d)} ${where} uses datasource uid "${ref.uid}"${ref.type ? ` (${ref.type})` : ""}, which no declared Datasource has. Declared: ${[...byUid.keys()].map((k) => `"${k}"`).join(", ")}.`,
          entity: uid,
        });
      } else if (ref.type && ref.type !== declared.type) {
        issues.push({
          code: "GRAF102",
          severity: "error",
          message: `${dashName(d)} ${where} sends a ${ref.type} query to datasource "${declared.name}", which is ${declared.type}.`,
          entity: uid,
        });
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
  for (const [uid, n] of dupes(a.datasources, (d) => d.uid)) push(`${n} datasources share the uid "${uid}".`, uid);
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

const BY_CODE: Record<GrafanaIssueCode, (a: GrafanaArtifacts) => GrafanaIssue[]> = {
  GRAF101: (a) => checkDatasourceRefs(a).filter((i) => i.code === "GRAF101"),
  GRAF102: (a) => checkDatasourceRefs(a).filter((i) => i.code === "GRAF102"),
  GRAF103: checkVariables,
  GRAF104: checkDuplicates,
  GRAF105: checkGrid,
  GRAF106: checkIdentity,
  GRAF107: checkSchema,
};

/** The issues one check finds. */
export function issuesFor(code: GrafanaIssueCode, a: GrafanaArtifacts): GrafanaIssue[] {
  return BY_CODE[code](a);
}

/** Every issue every check finds, in code order. */
export function validateGrafanaOutput(a: GrafanaArtifacts): GrafanaIssue[] {
  return (Object.keys(BY_CODE) as GrafanaIssueCode[]).flatMap((c) => issuesFor(c, a));
}
