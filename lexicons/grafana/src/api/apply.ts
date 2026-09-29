/**
 * The Grafana API applier (#2948): folders, library panels and dashboards
 * written over Grafana's HTTP API, stamped with chant's ownership labels,
 * and an owned-only prune.
 *
 * ## The API path
 *
 * The server's dashboard API is discovered once per client
 * (`dashboardApi` in ./dashboards.ts, shared with observe):
 *
 * - **Grafana 12.4 and 13.x**: `dashboard.grafana.app` (`v1beta1` on 12.4,
 *   `v1` on 13.x). A dashboard is created with `POST` to the collection and
 *   updated with `PUT` to its name, without a `resourceVersion`, which both
 *   versions accept as an unconditional update. The resource carries the
 *   classic JSON in `spec`, chant's labels in `metadata.labels`
 *   (`grafanaOwnershipLabels`, the marker observe reads back), and its
 *   folder in the `grafana.app/folder` annotation.
 * - **Grafana 11**: `POST /api/dashboards/db` with `overwrite: true` and the
 *   folder's uid. There is no metadata channel, so nothing is stamped and
 *   nothing is pruned: the prune reports both kinds as `not-prunable`.
 *
 * Folders are ./folders.ts and library panels ./library-panels.ts. The write
 * order is folders (parents first), then library panels, then dashboards, so
 * nothing is written before what it references.
 *
 * ## Unchanged
 *
 * Every write is preceded by a read, and a resource whose live content
 * already covers what would be sent (./converge.ts), with the same folder
 * and labels, is `unchanged` and not written.
 *
 * ## Prune
 *
 * Only with `prune`, and only what carries this project's marker: chant's
 * managed-by label with the same stack and the same env (an env-less marker
 * matches only an env-less apply). Dashboards go first, then folders, a
 * child before its parent, and a folder that still holds anything after
 * that (a dashboard saved into it in the UI, a library panel) is left, as
 * `not-prunable` with what it holds. Library panels are never pruned: their
 * API has no labels.
 */

import { hasOwnershipMarker, type OwnershipMarker } from "@intentius/chant/ownership";
import type { NotAttemptedReason } from "@intentius/chant/apply";
import { GrafanaApiError, type GrafanaClient } from "./client";
import { DASHBOARD_GROUP, classicDashboardOf, dashboardApi, dashboardPath, listDashboards, readDashboard, type DashboardApi } from "./dashboards";
import {
  FOLDER_ANNOTATION,
  childrenFirst,
  deleteFolder,
  ensureFolder,
  folderApi,
  folderContentCount,
  foldersForDashboards,
  listFolders,
  send,
  type FolderPlan,
} from "./folders";
import { ensureLibraryPanel, libraryPanelsOf, withoutExportKeys, type LibraryPanelPlan } from "./library-panels";
import { converged } from "./converge";
import { GRAFANA_OWNERSHIP_KEYS, grafanaOwnershipLabels } from "../ownership";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The kinds the applier names in its result: Grafana's own type names. */
export const GRAFANA_APPLY_KINDS = {
  dashboard: "Dashboard",
  folder: "Folder",
  libraryPanel: "LibraryPanel",
  /** An `__elements` entry that is not a panel (a library variable), which the applier cannot write. */
  libraryElement: "LibraryElement",
} as const;

/** One dashboard a build needs. */
export interface DashboardPlan {
  readonly uid: string;
  /** The classic dashboard JSON, without the export-only keys. */
  readonly json: Json;
  readonly folderUid?: string;
}

/** Everything one apply writes, in the order it writes it. */
export interface GrafanaApplyPlan {
  readonly folders: FolderPlan[];
  readonly libraryPanels: LibraryPanelPlan[];
  readonly dashboards: DashboardPlan[];
  /** What the input declared that the applier has no writer for. */
  readonly unsupported: Array<{ kind: string; name: string; detail: string }>;
}

/** A dashboard as the build hands it over: its JSON and the folder title it names. */
export interface BuiltDashboardInput {
  readonly json: Json;
  readonly folder?: string;
}

function sameJson(a: unknown, b: unknown): boolean {
  return converged(a, b) && converged(b, a);
}

/**
 * Turn built dashboards into an apply plan: the folders they name, the
 * library panels their `__elements` carry, and the dashboards themselves.
 * Throws on a plan no apply could satisfy: a dashboard with no uid, two
 * dashboards with one uid, or one library panel uid with two models.
 */
export function planFromDashboards(dashboards: readonly BuiltDashboardInput[]): GrafanaApplyPlan {
  const folders = foldersForDashboards(dashboards);
  const folderUid = new Map(folders.map((f) => [f.title, f.uid]));
  const libraryPanels = new Map<string, LibraryPanelPlan>();
  const unsupported: GrafanaApplyPlan["unsupported"] = [];
  const out: DashboardPlan[] = [];
  const seen = new Set<string>();
  for (const d of dashboards) {
    const uid = d.json.uid;
    if (typeof uid !== "string" || uid === "") throw new Error(`grafana apply: dashboard "${String(d.json.title ?? "?")}" has no uid`);
    if (seen.has(uid)) throw new Error(`grafana apply: two dashboards have the uid "${uid}"`);
    seen.add(uid);
    const inFolder = d.folder ? folderUid.get(d.folder) : undefined;
    const { panels, skipped } = libraryPanelsOf(d.json, inFolder);
    for (const p of panels) {
      const prior = libraryPanels.get(p.uid);
      if (prior && (prior.name !== p.name || !sameJson(prior.model, p.model))) {
        throw new Error(`grafana apply: library panel "${p.uid}" is carried by more than one dashboard with different content`);
      }
      if (!prior) libraryPanels.set(p.uid, p);
    }
    for (const name of skipped) {
      unsupported.push({ kind: GRAFANA_APPLY_KINDS.libraryElement, name, detail: `dashboard "${uid}" carries it in __elements, and only library panels (kind 1) can be applied` });
    }
    out.push({ uid, json: withoutExportKeys(d.json), ...(inFolder ? { folderUid: inFolder } : {}) });
  }
  return { folders: parentsFirst(folders), libraryPanels: [...libraryPanels.values()], dashboards: out, unsupported };
}

function parentsFirst(folders: FolderPlan[]): FolderPlan[] {
  const byUid = new Map(folders.map((f) => [f.uid, f]));
  const out: FolderPlan[] = [];
  const done = new Set<string>();
  const visit = (f: FolderPlan, active: Set<string>): void => {
    if (done.has(f.uid)) return;
    if (active.has(f.uid)) throw new Error(`grafana apply: folder "${f.uid}" is its own ancestor`);
    active.add(f.uid);
    const parent = f.parentUid ? byUid.get(f.parentUid) : undefined;
    if (parent) visit(parent, active);
    done.add(f.uid);
    out.push(f);
  };
  for (const f of folders) visit(f, new Set());
  return out;
}

/** Every resource in a plan, as `{ kind, name }`: what the result must account for. */
export function planRefs(plan: GrafanaApplyPlan): Array<{ kind: string; name: string }> {
  return [
    ...plan.folders.map((f) => ({ kind: GRAFANA_APPLY_KINDS.folder, name: f.uid })),
    ...plan.libraryPanels.map((p) => ({ kind: GRAFANA_APPLY_KINDS.libraryPanel, name: p.uid })),
    ...plan.dashboards.map((d) => ({ kind: GRAFANA_APPLY_KINDS.dashboard, name: d.uid })),
    ...plan.unsupported.map((u) => ({ kind: u.kind, name: u.name })),
  ];
}

export type AppliedAction = "created" | "updated" | "unchanged";

/** What the applier did, in its own terms. `toApplyResult` projects it onto core's envelope. */
export interface GrafanaApplyOutcome {
  /** Where the binding came from: `grafana.profiles.prod`, `env GRAFANA_URL`. Empty when nothing was bound. */
  target: string;
  /** The dashboard API written to: `apis/v1`, `apis/v1beta1` or `legacy`. Empty when nothing was written. */
  api: string;
  applied: Array<{ kind: string; name: string; action: AppliedAction; address: string }>;
  pruned: Array<{ kind: string; name: string; deleted: boolean; address: string }>;
  notAttempted: Array<{ kind: string; name: string; reason: NotAttemptedReason; detail?: string }>;
  /** Kinds the prune could not consider at all, and why. Empty without `prune`. */
  notPrunable: Array<{ kind: string; detail: string }>;
}

export interface ApplyGrafanaOptions {
  /**
   * The stack and env stamped on every dashboard and folder, and the only
   * marker the prune deletes. Without it, only the managed-by label is
   * stamped and the prune does nothing (it reports why).
   */
  marker?: OwnershipMarker;
  /** Delete this project's dashboards and folders that the plan no longer has. Off by default. */
  prune?: boolean;
  signal?: AbortSignal;
}

function apiLabel(api: DashboardApi): string {
  return api.kind === "apis" ? `apis/${api.version}` : "legacy";
}

/** The labels an apply stamps: the full marker, or only managed-by when no stack is known. */
export function stampLabels(marker: OwnershipMarker | undefined): Record<string, string> {
  return marker ? grafanaOwnershipLabels(marker) : { [GRAFANA_OWNERSHIP_KEYS.managedBy]: "chant" };
}

/** True when `labels` carry exactly this project's marker: chant's, this stack, this env. */
export function carriesMarker(labels: Readonly<Record<string, string>>, marker: OwnershipMarker): boolean {
  if (!hasOwnershipMarker(labels, GRAFANA_OWNERSHIP_KEYS)) return false;
  return labels[GRAFANA_OWNERSHIP_KEYS.stack] === marker.stack && (labels[GRAFANA_OWNERSHIP_KEYS.env] ?? undefined) === (marker.env || undefined);
}

function sameLabels(live: Readonly<Record<string, string>>, want: Readonly<Record<string, string>>): boolean {
  return Object.entries(want).every(([k, v]) => live[k] === v);
}

/** The spec sent for a dashboard: its JSON without the identity keys the resource carries elsewhere. */
function specOf(json: Json): Json {
  const { id: _id, uid: _uid, version: _version, ...spec } = json;
  return spec;
}

/**
 * Create or update one dashboard. Unchanged, with nothing written, when the
 * live dashboard already covers the JSON and sits in the same folder with
 * the same labels.
 */
export async function ensureDashboard(
  client: GrafanaClient,
  plan: DashboardPlan,
  labels: Readonly<Record<string, string>>,
): Promise<{ action: AppliedAction; address: string }> {
  const api = await dashboardApi(client);
  const read = await readDashboard(client, plan.uid);
  const live = "present" in read ? read.present : undefined;
  const address = dashboardPath(api, client.namespace, plan.uid);
  const classic = live ? classicDashboardOf(live) : undefined;
  const sameFolder = (live?.folderUid ?? "") === (plan.folderUid ?? "");
  const sameContent = classic !== undefined && "json" in classic && converged(plan.json, classic.json, { dashboard: true });

  if (api.kind === "apis") {
    if (live && sameContent && sameFolder && sameLabels(live.labels, labels)) return { action: "unchanged", address };
    // Labels are merged, so a label another tool put on the dashboard stays.
    const metadata = {
      name: plan.uid,
      labels: { ...(live?.labels ?? {}), ...labels },
      ...(plan.folderUid ? { annotations: { [FOLDER_ANNOTATION]: plan.folderUid } } : {}),
    };
    const resource = { apiVersion: `${DASHBOARD_GROUP}/${api.version}`, kind: "Dashboard", metadata, spec: specOf(plan.json) };
    if (live) {
      await send(client, "PUT", address, resource);
      return { action: "updated", address };
    }
    await send(client, "POST", address.slice(0, address.lastIndexOf("/")), resource);
    return { action: "created", address };
  }

  if (live && sameContent && sameFolder) return { action: "unchanged", address };
  const { id: _id, version: _version, ...dashboard } = plan.json;
  await send(client, "POST", "/api/dashboards/db", {
    dashboard: { ...dashboard, uid: plan.uid },
    folderUid: plan.folderUid ?? "",
    overwrite: true,
    message: "chant apply",
  });
  return { action: live ? "updated" : "created", address };
}

/** Delete one dashboard over `/apis`. False when it was already gone. */
async function deleteDashboard(client: GrafanaClient, address: string): Promise<boolean> {
  const res = await client.http("DELETE", address);
  if (res.status === 404) return false;
  if (res.status < 200 || res.status >= 300) throw new GrafanaApiError(res.status, "DELETE", address, res.json);
  return true;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("grafana apply aborted");
}

/**
 * Apply `plan` to the Grafana behind `client`. Throws `GrafanaApiError` when
 * a write fails; a refused first read (401/403) is returned instead, with
 * every resource `no-credentials`, since nothing was written.
 */
export async function applyGrafana(client: GrafanaClient, plan: GrafanaApplyPlan, opts: ApplyGrafanaOptions = {}): Promise<GrafanaApplyOutcome> {
  const outcome: GrafanaApplyOutcome = {
    target: client.target.source,
    api: "",
    applied: [],
    pruned: [],
    notAttempted: plan.unsupported.map((u) => ({ kind: u.kind, name: u.name, reason: "unsupported-kind" as const, detail: u.detail })),
    notPrunable: [],
  };

  let api: DashboardApi;
  try {
    api = await dashboardApi(client);
  } catch (err) {
    if (err instanceof GrafanaApiError && err.verdict === "refused") {
      const detail = `${err.message} (the credentials for ${client.target.source} were refused)`;
      for (const ref of planRefs(plan)) {
        if (!plan.unsupported.some((u) => u.kind === ref.kind && u.name === ref.name)) outcome.notAttempted.push({ ...ref, reason: "no-credentials", detail });
      }
      return outcome;
    }
    throw err;
  }
  outcome.api = apiLabel(api);
  const labels = stampLabels(opts.marker);

  for (const folder of plan.folders) {
    checkAborted(opts.signal);
    const r = await ensureFolder(client, folder, labels);
    outcome.applied.push({ kind: GRAFANA_APPLY_KINDS.folder, name: folder.uid, action: r.action, address: r.address });
  }
  for (const panel of plan.libraryPanels) {
    checkAborted(opts.signal);
    const r = await ensureLibraryPanel(client, panel);
    outcome.applied.push({ kind: GRAFANA_APPLY_KINDS.libraryPanel, name: panel.uid, action: r.action, address: r.address });
  }
  for (const dashboard of plan.dashboards) {
    checkAborted(opts.signal);
    const r = await ensureDashboard(client, dashboard, labels);
    outcome.applied.push({ kind: GRAFANA_APPLY_KINDS.dashboard, name: dashboard.uid, action: r.action, address: r.address });
  }

  if (opts.prune) await prune(client, plan, api, opts, outcome);
  return outcome;
}

async function prune(client: GrafanaClient, plan: GrafanaApplyPlan, api: DashboardApi, opts: ApplyGrafanaOptions, outcome: GrafanaApplyOutcome): Promise<void> {
  const marker = opts.marker;
  if (plan.libraryPanels.length > 0) {
    outcome.notPrunable.push({ kind: GRAFANA_APPLY_KINDS.libraryPanel, detail: "the library elements API has no labels, so a library panel cannot carry chant's marker" });
  }
  if (!marker) {
    const detail = "no ownership stack: set ownership.stack in chant.config.ts, or pass stack, so the prune can tell this project's resources from another's";
    outcome.notPrunable.push({ kind: GRAFANA_APPLY_KINDS.dashboard, detail }, { kind: GRAFANA_APPLY_KINDS.folder, detail });
    return;
  }

  if (api.kind === "legacy") {
    outcome.notPrunable.push({ kind: GRAFANA_APPLY_KINDS.dashboard, detail: "this Grafana has no dashboard.grafana.app API (Grafana 11), and /api/dashboards has no labels to read the marker from" });
  } else {
    const keep = new Set(plan.dashboards.map((d) => d.uid));
    for (const live of await listDashboards(client)) {
      if (keep.has(live.uid) || !carriesMarker(live.labels, marker)) continue;
      checkAborted(opts.signal);
      const address = dashboardPath(api, client.namespace, live.uid);
      outcome.pruned.push({ kind: GRAFANA_APPLY_KINDS.dashboard, name: live.uid, deleted: await deleteDashboard(client, address), address });
    }
  }

  const fApi = await folderApi(client);
  if (fApi.kind === "legacy") {
    outcome.notPrunable.push({ kind: GRAFANA_APPLY_KINDS.folder, detail: "this Grafana has no folder.grafana.app API, and /api/folders has no labels to read the marker from" });
    return;
  }
  const keep = new Set(plan.folders.map((f) => f.uid));
  const orphans = (await listFolders(client)).filter((f) => !keep.has(f.uid) && carriesMarker(f.labels, marker));
  for (const folder of childrenFirst(orphans)) {
    checkAborted(opts.signal);
    const held = await folderContentCount(client, folder.uid);
    if (held > 0) {
      outcome.notAttempted.push({
        kind: GRAFANA_APPLY_KINDS.folder,
        name: folder.uid,
        reason: "not-prunable",
        detail: `folder "${folder.title}" is this project's and no longer declared, but still holds ${held} item(s) chant does not prune (a dashboard saved into it, a library panel); it is left`,
      });
      continue;
    }
    outcome.pruned.push({ kind: GRAFANA_APPLY_KINDS.folder, name: folder.uid, deleted: await deleteFolder(client, folder), address: folder.address });
  }
}

/** Parse a stored dashboard JSON file's content; throws with the file name when it is not a JSON object. */
export function parseDashboardFile(content: string, file: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`grafana apply: ${file} is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(parsed)) throw new Error(`grafana apply: ${file} is not a dashboard JSON object`);
  return parsed;
}
