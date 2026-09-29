/**
 * From declared entities to Grafana's own files: dashboard JSON, the
 * datasource provisioning file and the dashboard provisioning file.
 *
 * Plain functions, so another lexicon (a k8s ConfigMap, a docker volume)
 * can render the same files with `grafanaFiles()` or one dashboard with
 * `dashboardJson()`, and the serializer is a thin wrapper around
 * `buildGrafana()`.
 */

import { dump } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { isDatasourceDeclaration, isDatasourceEntity, isExternalDatasource, type DatasourceEntity, type DatasourceRef, type ExternalDatasourceEntity } from "./datasource";
import {
  isDashboardEntity,
  isDashboardProviderEntity,
  DEFAULT_DASHBOARDS_PATH,
  type DashboardEntity,
  type DashboardLinkInput,
  type DashboardProviderProps,
} from "./dashboard";
import { isPanelEntity, isRowEntity, type PanelEntity, type RowEntity, type PanelLink } from "./panels";
import { isQueryEntity, type QueryEntity, type DatasourceInput } from "./query";
import { isDatasourceVariable, isVariableEntity, type VariableEntity, type VariableHide } from "./variables";
import type {
  Dashboard as DashboardJson,
  DashboardLink,
  DataSourceRef,
  GridPos,
  Panel as PanelJson,
  RowPanel as RowPanelJson,
  VariableModel,
} from "./schema/dashboard.gen";
import { DASHBOARD_SCHEMA_VERSION } from "./schema/dashboard.gen";
import { GRAFANA_SCHEMA_PIN } from "./pin";
import { compact, slugUid } from "./util";
import { ALERTING_FILE, alertingYaml, buildAlerting, type AlertingFile, type AlertingIndex } from "./alerting-build";

export type { DashboardJson, PanelJson, RowPanelJson, VariableModel, DataSourceRef };

/** Grafana's grid is 24 columns wide. */
export const GRID_COLUMNS = 24;

/** Where each file goes, relative to the build output directory. */
export const DATASOURCES_FILE = "provisioning/datasources/chant.yaml";
export const DASHBOARD_PROVIDERS_FILE = "provisioning/dashboards/chant.yaml";
export const DASHBOARDS_DIR = "dashboards";

/** One entry of `datasources:` in a provisioning file. */
export interface ProvisionedDatasource {
  name: string;
  type: string;
  uid: string;
  access?: string;
  url?: string;
  isDefault?: boolean;
  basicAuth?: boolean;
  basicAuthUser?: string;
  user?: string;
  database?: string;
  withCredentials?: boolean;
  jsonData?: Record<string, unknown>;
  secureJsonData?: Record<string, string>;
  editable?: boolean;
  orgId?: number;
  version?: number;
}

/** One entry of `providers:` in a dashboard provisioning file. */
export interface ProvisionedProvider {
  name: string;
  orgId: number;
  folder: string;
  folderUid?: string;
  type: "file";
  disableDeletion: boolean;
  allowUiUpdates: boolean;
  updateIntervalSeconds: number;
  options: { path: string; foldersFromFilesStructure: boolean };
}

export interface BuiltDashboard {
  uid: string;
  title: string;
  folder?: string;
  /** Path of its JSON file, relative to the output directory. */
  file: string;
  json: DashboardJson;
}

export interface BuiltGrafana {
  dashboards: BuiltDashboard[];
  datasources: ProvisionedDatasource[];
  /** `ExternalDatasource` declarations: the checks count them, the provisioning file leaves them out. */
  externalDatasources: ExternalDatasourceRecord[];
  providers: ProvisionedProvider[];
  /** The alerting provisioning file, when the build declares any alerting. */
  alerting?: AlertingFile;
  /** Every output file by path, ready to write. */
  files: Record<string, string>;
  /** A short summary of what was built: the serializer's primary output. */
  index: GrafanaIndex;
}

export interface GrafanaIndex {
  grafanaSchema: string;
  dashboards: Array<{ uid: string; title: string; folder?: string; file: string }>;
  datasources: Array<{ name: string; type: string; uid: string }>;
  /** Datasources declared with `ExternalDatasource`: referenced, never provisioned. */
  externalDatasources?: ExternalDatasourceRecord[];
  /** Rule groups, contact points, policies, mute timings and templates, when the build declares any. */
  alerting?: AlertingIndex;
  files: string[];
}

/** An `ExternalDatasource` as the checks and the index see it. */
export interface ExternalDatasourceRecord {
  type: string;
  uid: string;
  name?: string;
}

// ── References ──────────────────────────────────────────────────

function isRef(value: unknown): value is DatasourceRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DatasourceRef).type === "string" &&
    typeof (value as DatasourceRef).uid === "string" &&
    !("lexicon" in (value as object))
  );
}

/** The `{ type, uid }` Grafana stores for a datasource (declared or external), a datasource variable, or a ref. */
export function datasourceRef(input: DatasourceInput | undefined): DataSourceRef | undefined {
  if (input === undefined || input === null) return undefined;
  if (isDatasourceDeclaration(input)) return { type: input.datasourceType, uid: input.uid };
  if (isDatasourceVariable(input)) return { type: input.pluginType, uid: `\${${input.variableName}}` };
  if (isRef(input)) return { type: input.type, uid: input.uid };
  throw new Error("grafana: a datasource must be a Datasource, an ExternalDatasource, a DatasourceVariable or a { type, uid } ref");
}

function sameRef(a: DataSourceRef | undefined, b: DataSourceRef | undefined): boolean {
  return a?.type === b?.type && a?.uid === b?.uid;
}

const MIXED: DataSourceRef = { type: "datasource", uid: "-- Mixed --" };

// ── Links ───────────────────────────────────────────────────────

function dashboardLink(link: DashboardLinkInput | PanelLink): DashboardLink {
  return compact({
    title: link.title,
    type: link.type ?? "link",
    url: link.url,
    icon: link.icon ?? "external link",
    tooltip: link.tooltip ?? "",
    tags: link.tags ?? [],
    asDropdown: link.asDropdown ?? false,
    placement: link.placement,
    targetBlank: link.targetBlank ?? false,
    includeVars: link.includeVars ?? false,
    keepTime: link.keepTime ?? false,
  });
}

// ── Variables ───────────────────────────────────────────────────

const HIDE: Record<VariableHide, 0 | 1 | 2> = { label: 0, valueOnly: 1, hidden: 2 };
const REFRESH = { never: 0, onLoad: 1, onTimeRangeChange: 2 } as const;

function escapeCustom(v: string): string {
  return v.replace(/,/g, "\\,");
}

function optionsOf(values: string[], current?: { text: string | string[]; value: string | string[] }) {
  const selected = current ? (Array.isArray(current.value) ? current.value : [current.value]) : values.slice(0, 1);
  return values.map((v) => ({ selected: selected.includes(v), text: v, value: v }));
}

/** One variable as Grafana's `templating.list` entry. */
export function variableModel(variable: VariableEntity): VariableModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = variable.props as any;
  const common = {
    type: variable.variableKind,
    name: p.name,
    label: p.label,
    description: p.description,
    hide: p.hide === undefined ? undefined : HIDE[p.hide as VariableHide],
    skipUrlSync: p.skipUrlSync,
  };
  const multi = { multi: p.multi, includeAll: p.includeAll, allValue: p.allValue };
  switch (variable.variableKind) {
    case "query":
      return compact({
        ...common,
        datasource: datasourceRef(p.datasource),
        query: p.query,
        definition: p.query,
        regex: p.regex,
        refresh: REFRESH[(p.refresh ?? "onLoad") as keyof typeof REFRESH],
        sort: p.sort,
        ...multi,
        current: p.current,
        options: [],
      }) as VariableModel;
    case "custom": {
      const values: string[] = p.values;
      const current = p.current ?? (values[0] !== undefined ? { text: values[0], value: values[0] } : undefined);
      return compact({
        ...common,
        query: values.map(escapeCustom).join(","),
        ...multi,
        current,
        options: optionsOf(values, current),
      }) as VariableModel;
    }
    case "interval": {
      const values: string[] = p.values;
      const current = p.current ?? (values[0] !== undefined ? { text: values[0], value: values[0] } : undefined);
      return compact({
        ...common,
        query: values.join(","),
        current,
        options: optionsOf(values, current),
        auto: p.auto ?? false,
        auto_count: p.autoCount ?? 30,
        auto_min: p.autoMin ?? "10s",
        refresh: 2,
      }) as VariableModel;
    }
    case "datasource":
      return compact({
        ...common,
        query: p.pluginType,
        regex: p.regex ?? "",
        ...multi,
        current: p.current,
        refresh: 1,
        options: [],
      }) as VariableModel;
    case "constant":
      return compact({
        ...common,
        hide: 2,
        query: p.value,
        current: { text: p.value, value: p.value },
      }) as VariableModel;
    case "textbox":
      return compact({
        ...common,
        query: p.value ?? "",
        current: { text: p.value ?? "", value: p.value ?? "" },
      }) as VariableModel;
  }
}

// ── Panels and layout ───────────────────────────────────────────

function repeatName(repeat: VariableEntity | string | undefined): string | undefined {
  if (repeat === undefined) return undefined;
  return typeof repeat === "string" ? repeat : repeat.variableName;
}

const REF_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function refIdAt(i: number): string {
  return i < REF_IDS.length ? REF_IDS[i] : `${REF_IDS[Math.floor(i / REF_IDS.length) - 1]}${REF_IDS[i % REF_IDS.length]}`;
}

/** One query as a panel target. */
export function targetJson(query: QueryEntity, index: number, panelDatasource?: DataSourceRef): Record<string, unknown> {
  const def = query.queryDefinition;
  const { datasource, ...model } = query.props as Record<string, unknown> & { datasource?: DatasourceInput };
  const ref = datasourceRef(datasource) ?? panelDatasource;
  return compact({
    datasource: ref,
    refId: (model.refId as string | undefined) ?? refIdAt(index),
    ...(def.defaults ?? {}),
    ...model,
  });
}

/** A bitmask of grid columns [x, x + w), clipped to the grid. */
function columns(x: number, w: number): number {
  const from = Math.max(0, x);
  const to = Math.min(GRID_COLUMNS, x + w);
  return to > from ? ((1 << (to - from)) - 1) << from : 0;
}

/**
 * Places panels on Grafana's grid. It keeps an occupancy grid, so a panel
 * placed automatically never lands on one placed explicitly (reserved up
 * front) or on one placed before it.
 */
class Layout {
  private x = 0;
  private y: number;
  private lineH = 0;
  private bottom: number;
  /** Taken cells: one column bitmask per grid line. */
  private readonly taken: number[] = [];

  constructor(top = 0) {
    this.y = top;
    this.bottom = top;
  }

  /** Marks the cells of a panel with both `x` and `y` as taken, before anything is placed. */
  reserve(gp: Partial<GridPos> | undefined, size: { w: number; h: number }): void {
    if (gp?.x === undefined || gp?.y === undefined) return;
    this.take(gp.x, gp.y, gp.w ?? size.w, gp.h ?? size.h);
  }

  place(gp: Partial<GridPos> | undefined, size: { w: number; h: number }): GridPos {
    const w = gp?.w ?? size.w;
    const h = gp?.h ?? size.h;
    if (gp?.x !== undefined && gp?.y !== undefined) {
      this.take(gp.x, gp.y, w, h);
      this.bottom = Math.max(this.bottom, gp.y + h);
      return { h, w, x: gp.x, y: gp.y };
    }
    if (gp?.y !== undefined) {
      // Only `y`: the first free column on that line, else on the first line below with room.
      for (let y = Math.max(0, gp.y); ; y++) {
        const x = this.freeColumn(0, y, w, h);
        if (x === undefined) continue;
        this.take(x, y, w, h);
        this.bottom = Math.max(this.bottom, y + h);
        return { h, w, x, y };
      }
    }
    // Flow: the first free spot on the current line after the previous panel, else the next line.
    // Only `x`: that column, on the first line where it is free.
    for (;;) {
      const x =
        gp?.x === undefined
          ? this.freeColumn(this.x, this.y, w, h)
          : gp.x >= this.x && this.free(gp.x, this.y, w, h)
            ? gp.x
            : undefined;
      if (x !== undefined) {
        const pos = { h, w, x, y: this.y };
        this.take(x, this.y, w, h);
        this.x = x + w;
        this.lineH = Math.max(this.lineH, h);
        this.bottom = Math.max(this.bottom, this.y + h);
        return pos;
      }
      this.y += this.lineH || 1;
      this.x = 0;
      this.lineH = 0;
    }
  }

  /** A full-width row header on the first free line below everything placed so far. */
  row(): GridPos {
    let y = Math.max(this.bottom, this.y + this.lineH);
    while (!this.free(0, y, GRID_COLUMNS, 1)) y++;
    this.take(0, y, GRID_COLUMNS, 1);
    this.x = 0;
    this.y = y + 1;
    this.lineH = 0;
    this.bottom = y + 1;
    return { h: 1, w: GRID_COLUMNS, x: 0, y };
  }

  /** The first column at or after `from` where a w×h panel fits on line `y`. A panel wider than the grid fits only at 0. */
  private freeColumn(from: number, y: number, w: number, h: number): number | undefined {
    for (let x = from; x === 0 || x + w <= GRID_COLUMNS; x++) if (this.free(x, y, w, h)) return x;
    return undefined;
  }

  private free(x: number, y: number, w: number, h: number): boolean {
    const mask = columns(x, w);
    for (let line = Math.max(0, y); line < y + h; line++) if ((this.taken[line] ?? 0) & mask) return false;
    return true;
  }

  private take(x: number, y: number, w: number, h: number): void {
    const mask = columns(x, w);
    for (let line = Math.max(0, y); line < y + h; line++) this.taken[line] = (this.taken[line] ?? 0) | mask;
  }
}

class Ids {
  private next = 1;
  constructor(private readonly taken: Set<number>) {}
  take(explicit?: number): number {
    if (explicit !== undefined) return explicit;
    while (this.taken.has(this.next)) this.next++;
    return this.next++;
  }
}

function explicitIds(items: Array<PanelEntity | RowEntity>): Set<number> {
  const out = new Set<number>();
  for (const item of items) {
    if (typeof item.props.id === "number") out.add(item.props.id);
    if (isRowEntity(item)) for (const p of item.props.panels ?? []) if (typeof p.props.id === "number") out.add(p.props.id);
  }
  return out;
}

function panelJson(panel: PanelEntity, gridPos: GridPos, id: number, inherited?: DataSourceRef): PanelJson {
  const p = panel.props;
  const def = panel.panelDefinition;
  const own = datasourceRef(p.datasource) ?? inherited;
  const queries = (p.targets ?? []).filter(isQueryEntity);
  const targets = queries.map((q, i) => targetJson(q, i, own));
  const refs = targets.map((t) => t.datasource as DataSourceRef | undefined);
  let datasource = own;
  if (!datasource && refs.length > 0) {
    datasource = refs.every((r) => sameRef(r, refs[0])) ? refs[0] : MIXED;
  } else if (datasource && refs.some((r) => r && !sameRef(r, datasource))) {
    datasource = MIXED;
  }
  const fieldConfig = {
    defaults: { ...(p.fieldConfig?.defaults ?? {}) },
    overrides: p.fieldConfig?.overrides ?? [],
  };
  return compact({
    type: def.type,
    id,
    title: p.title ?? "",
    description: p.description,
    gridPos,
    datasource,
    targets: targets.length > 0 ? targets : undefined,
    options: (p.options ?? {}) as Record<string, unknown>,
    fieldConfig,
    transformations: p.transformations,
    links: p.links?.map(dashboardLink),
    repeat: repeatName(p.repeat),
    repeatDirection: p.repeatDirection,
    maxPerRow: p.maxPerRow,
    maxDataPoints: p.maxDataPoints,
    interval: p.interval,
    timeFrom: p.timeFrom,
    timeShift: p.timeShift,
    hideTimeOverride: p.hideTimeOverride,
    transparent: p.transparent,
    pluginVersion: p.pluginVersion,
  }) as PanelJson;
}

/** A dashboard's `panels` array: rows and panels, laid out, with ids. */
export function panelsJson(items: Array<PanelEntity | RowEntity>): Array<PanelJson | RowPanelJson> {
  const layout = new Layout();
  // Panels on the dashboard's grid with both x and y take their cells first; a collapsed row's are laid out on their own.
  for (const item of items) {
    const onGrid = isRowEntity(item) ? (item.props.collapsed ? [] : (item.props.panels ?? [])) : [item];
    for (const p of onGrid.filter(isPanelEntity)) layout.reserve(p.props.gridPos, p.panelDefinition.defaultSize);
  }
  const ids = new Ids(explicitIds(items));
  const out: Array<PanelJson | RowPanelJson> = [];
  for (const item of items) {
    if (isRowEntity(item)) {
      const r = item.props;
      const pos = layout.row();
      const rowId = ids.take(r.id);
      const rowRef = datasourceRef(r.datasource);
      const collapsed = r.collapsed ?? false;
      // A collapsed row's panels sit under its header on a grid of their own; the next item starts right under the header.
      const rowLayout = collapsed ? new Layout(pos.y + 1) : layout;
      const panels = (r.panels ?? []).filter(isPanelEntity);
      if (collapsed) for (const p of panels) rowLayout.reserve(p.props.gridPos, p.panelDefinition.defaultSize);
      const children = panels.map((p) => {
        const gp = rowLayout.place(p.props.gridPos, p.panelDefinition.defaultSize);
        return panelJson(p, gp, ids.take(p.props.id), rowRef);
      });
      out.push(
        compact({
          type: "row" as const,
          collapsed,
          title: r.title,
          datasource: rowRef,
          gridPos: pos,
          id: rowId,
          panels: collapsed ? children : [],
          repeat: repeatName(r.repeat),
        }),
      );
      if (!collapsed) out.push(...children);
    } else if (isPanelEntity(item)) {
      const gp = layout.place(item.props.gridPos, item.panelDefinition.defaultSize);
      out.push(panelJson(item, gp, ids.take(item.props.id)));
    }
  }
  return out;
}

// ── Dashboards ──────────────────────────────────────────────────

const GRAPH_TOOLTIP = { default: 0, sharedCrosshair: 1, sharedTooltip: 2 } as const;

/** The dashboard's uid: its own, else from its export name, else from its title. */
export function dashboardUid(dashboard: DashboardEntity, exportName?: string): string {
  return dashboard.props.uid ?? slugUid(exportName ?? dashboard.props.title);
}

/** One dashboard as the JSON Grafana imports. */
export function renderDashboard(dashboard: DashboardEntity, exportName?: string): DashboardJson {
  const p = dashboard.props;
  return compact({
    annotations: { list: [] },
    description: p.description,
    editable: p.editable ?? true,
    fiscalYearStartMonth: p.fiscalYearStartMonth ?? 0,
    graphTooltip: GRAPH_TOOLTIP[p.graphTooltip ?? "default"],
    links: (p.links ?? []).map(dashboardLink),
    liveNow: p.liveNow,
    panels: panelsJson(p.panels ?? []),
    refresh: p.refresh,
    schemaVersion: p.schemaVersion ?? DASHBOARD_SCHEMA_VERSION,
    tags: p.tags ?? [],
    templating: { list: (p.variables ?? []).filter(isVariableEntity).map(variableModel) },
    time: p.time ?? { from: "now-6h", to: "now" },
    timepicker: p.timepicker ?? {},
    timezone: p.timezone ?? "browser",
    title: p.title,
    uid: dashboardUid(dashboard, exportName),
    weekStart: p.weekStart ?? "",
  }) as DashboardJson;
}

/** One dashboard as formatted JSON text. */
export function dashboardJson(dashboard: DashboardEntity, exportName?: string): string {
  return `${JSON.stringify(renderDashboard(dashboard, exportName), null, 2)}\n`;
}

// ── Datasources and providers ───────────────────────────────────

/** Replace every declared or external datasource inside plugin settings with its uid. */
function resolveNested(value: unknown): unknown {
  if (isDatasourceDeclaration(value)) return value.uid;
  if (Array.isArray(value)) return value.map(resolveNested);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveNested(v)]));
  }
  return value;
}

/** One datasource as a provisioning entry. */
export function provisionedDatasource(ds: DatasourceEntity): ProvisionedDatasource {
  const p = ds.props;
  return compact({
    name: p.name,
    type: p.type,
    uid: ds.uid,
    access: p.access ?? "proxy",
    url: p.url,
    isDefault: p.isDefault,
    basicAuth: p.basicAuth,
    basicAuthUser: p.basicAuthUser,
    user: p.user,
    database: p.database,
    withCredentials: p.withCredentials,
    jsonData: p.jsonData === undefined ? undefined : (resolveNested(p.jsonData) as Record<string, unknown>),
    secureJsonData: p.secureJsonData,
    editable: p.editable ?? false,
    orgId: p.orgId,
    version: p.version,
  });
}

/** One `ExternalDatasource` as the checks and the index see it. */
export function externalDatasourceRecord(ds: ExternalDatasourceEntity): ExternalDatasourceRecord {
  return compact({ type: ds.datasourceType, uid: ds.uid, name: ds.props.name });
}

/** One dashboard provider as a provisioning entry. */
export function provisionedProvider(p: DashboardProviderProps): ProvisionedProvider {
  const pinnedFolder = p.folder !== undefined || p.folderUid !== undefined;
  return compact({
    name: p.name,
    orgId: p.orgId ?? 1,
    folder: p.folder ?? "",
    folderUid: p.folderUid,
    type: "file" as const,
    disableDeletion: p.disableDeletion ?? false,
    allowUiUpdates: p.allowUiUpdates ?? false,
    updateIntervalSeconds: p.updateIntervalSeconds ?? 30,
    options: {
      path: p.path ?? DEFAULT_DASHBOARDS_PATH,
      foldersFromFilesStructure: p.foldersFromFilesStructure ?? !pinnedFolder,
    },
  });
}

function yamlFile(header: string, body: Record<string, unknown>): string {
  return `# ${header}\n${dump(body, { lineWidth: -1, noRefs: true, quotingType: '"' })}`;
}

/** The datasource provisioning file for these datasources. */
export function datasourcesYaml(datasources: ProvisionedDatasource[]): string {
  return yamlFile("Grafana datasource provisioning, generated by chant.", { apiVersion: 1, datasources });
}

/** The dashboard provisioning file for these providers. */
export function dashboardProvidersYaml(providers: ProvisionedProvider[]): string {
  return yamlFile("Grafana dashboard provisioning, generated by chant.", { apiVersion: 1, providers });
}

function folderDir(folder: string): string {
  return folder.replace(/[/\\]+/g, "-").replace(/^\.+/, "").trim() || "General";
}

// ── The whole build ─────────────────────────────────────────────

/** Everything the grafana entities in a build render to. */
export function buildGrafana(entities: Map<string, Declarable> | Iterable<Declarable>): BuiltGrafana {
  const named: Array<[string | undefined, Declarable]> =
    entities instanceof Map ? [...entities.entries()] : [...entities].map((e) => [undefined, e]);
  const files: Record<string, string> = {};

  // Sorted by name, so the provisioning file doesn't depend on which source file was read first.
  const datasources = named
    .filter(([, e]) => isDatasourceEntity(e))
    .map(([, e]) => provisionedDatasource(e as DatasourceEntity))
    .sort((a, b) => a.name.localeCompare(b.name));

  const externalDatasources: ExternalDatasourceRecord[] = named
    .filter(([, e]) => isExternalDatasource(e))
    .map(([, e]) => externalDatasourceRecord(e as ExternalDatasourceEntity))
    .sort((a, b) => a.uid.localeCompare(b.uid));

  const dashboards: BuiltDashboard[] = [];
  for (const [name, e] of named) {
    if (!isDashboardEntity(e)) continue;
    const json = renderDashboard(e, name);
    const uid = json.uid as string;
    const folder = e.props.folder;
    const dir = folder ? `${DASHBOARDS_DIR}/${folderDir(folder)}` : DASHBOARDS_DIR;
    let file = `${dir}/${uid}.json`;
    for (let n = 2; file in files; n++) file = `${dir}/${uid}-${n}.json`;
    files[file] = `${JSON.stringify(json, null, 2)}\n`;
    dashboards.push({ uid, title: e.props.title, ...(folder ? { folder } : {}), file, json });
  }

  const declaredProviders = named.filter(([, e]) => isDashboardProviderEntity(e)).map(([, e]) => (e as unknown as { props: DashboardProviderProps }).props);
  const providers =
    declaredProviders.length > 0
      ? declaredProviders.map(provisionedProvider)
      : dashboards.length > 0
        ? [provisionedProvider({ name: "chant" })]
        : [];

  if (datasources.length > 0) files[DATASOURCES_FILE] = datasourcesYaml(datasources);
  if (providers.length > 0) files[DASHBOARD_PROVIDERS_FILE] = dashboardProvidersYaml(providers);
  const alerting = buildAlerting(named.map(([, e]) => e));
  if (alerting) files[ALERTING_FILE] = alertingYaml(alerting.file);

  const index: GrafanaIndex = {
    grafanaSchema: `${GRAFANA_SCHEMA_PIN.source}@${GRAFANA_SCHEMA_PIN.ref}`,
    dashboards: dashboards.map(({ uid, title, folder, file }) => ({ uid, title, ...(folder ? { folder } : {}), file })),
    datasources: datasources.map(({ name, type, uid }) => ({ name, type, uid })),
    ...(externalDatasources.length > 0 ? { externalDatasources } : {}),
    ...(alerting ? { alerting: alerting.index } : {}),
    files: Object.keys(files).sort(),
  };
  return { dashboards, datasources, externalDatasources, providers, ...(alerting ? { alerting: alerting.file } : {}), files, index };
}

/** Every file the grafana entities render to, by path relative to the output directory. */
export function grafanaFiles(entities: Map<string, Declarable> | Iterable<Declarable>): Record<string, string> {
  return buildGrafana(entities).files;
}
