/**
 * Folders, for the API applier (#2948). Every folder decision the applier
 * makes is in this module: which folders a build needs, the uid each gets,
 * how one is read, written, listed and deleted, and on which API.
 *
 * ## What the lexicon models today
 *
 * A dashboard names its folder by title (`Dashboard.folder`), and a title
 * holds no nesting (the build flattens `/` in it). So the applier derives
 * one root-level folder per distinct title, with a stable uid made from the
 * title ({@link folderUidFor}), and a second apply finds it again by that
 * uid. {@link FolderPlan} already carries `parentUid`, and the writers
 * already send it, so #2953 (folder uid and nesting on the declaration) only
 * has to change {@link foldersForDashboards}.
 *
 * ## Which API
 *
 * Grafana 12.4 serves `folder.grafana.app/v1beta1` and 13.x also serves
 * `v1`, both keeping `metadata.labels` as written (checked against 12.4.11
 * and 13.2.2), so a folder carries chant's ownership labels the same way a
 * dashboard does. The parent is the `grafana.app/folder` annotation, as on a
 * dashboard. A server without the group (Grafana 11) is written over
 * `/api/folders`, which has `parentUid` but no labels: a folder written
 * there cannot be told apart from anyone else's, so it is never pruned.
 */

import { GrafanaApiError, type GrafanaClient } from "./client";
import { slugUid } from "../util";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
}

export const FOLDER_GROUP = "folder.grafana.app";

/** Folder API versions chant writes, newest first. */
export const FOLDER_VERSIONS: readonly string[] = ["v1", "v1beta1"];

/** The annotation that names a folder's (or a dashboard's) parent folder on `/apis`. */
export const FOLDER_ANNOTATION = "grafana.app/folder";

/** How this server serves folders. */
export type FolderApi = { readonly kind: "apis"; readonly version: string } | { readonly kind: "legacy" };

/** One folder a build needs. */
export interface FolderPlan {
  readonly uid: string;
  readonly title: string;
  /** The parent folder's uid; absent for a root-level folder. */
  readonly parentUid?: string;
}

/** A folder as Grafana holds it. */
export interface LiveFolder {
  readonly uid: string;
  readonly title: string;
  readonly parentUid?: string;
  /** `metadata.labels`; empty on the legacy API. */
  readonly labels: Readonly<Record<string, string>>;
  readonly via: "apis" | "legacy";
  /** The request path it lives at. */
  readonly address: string;
  /** The legacy folder's `version`, which its update needs. */
  readonly version?: number;
}

/**
 * The uid chant gives the folder a dashboard names by title. Stable, so a
 * second apply finds the folder the first one made; Grafana's own limit is
 * 40 characters, which `slugUid` keeps to.
 */
export function folderUidFor(title: string): string {
  return slugUid(title);
}

/**
 * The folders a set of dashboards needs, one per distinct title, sorted by
 * uid. The one place a dashboard's folder becomes a folder plan.
 */
export function foldersForDashboards(dashboards: Iterable<{ folder?: string }>): FolderPlan[] {
  const byUid = new Map<string, FolderPlan>();
  for (const d of dashboards) {
    if (!d.folder) continue;
    const uid = folderUidFor(d.folder);
    const seen = byUid.get(uid);
    if (seen && seen.title !== d.folder) {
      throw new Error(`grafana apply: the folders "${seen.title}" and "${d.folder}" would both get the uid "${uid}"; rename one`);
    }
    byUid.set(uid, { uid, title: d.folder });
  }
  return [...byUid.values()].sort((a, b) => a.uid.localeCompare(b.uid));
}

/** The folder API the server behind `client` serves, discovered once per client. */
export function folderApi(client: GrafanaClient): Promise<FolderApi> {
  return client.once("folder-api", async () => {
    const group = await client.get<{ versions?: Array<{ version?: string }> }>(`/apis/${FOLDER_GROUP}`);
    const served = new Set((group?.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string"));
    const version = FOLDER_VERSIONS.find((v) => served.has(v));
    return version ? { kind: "apis", version } : { kind: "legacy" };
  });
}

function collection(api: Extract<FolderApi, { kind: "apis" }>, namespace: string): string {
  return `/apis/${FOLDER_GROUP}/${api.version}/namespaces/${encodeURIComponent(namespace)}/folders`;
}

/** The request path for one folder on this API. */
export function folderPath(api: FolderApi, namespace: string, uid: string): string {
  return api.kind === "apis" ? `${collection(api, namespace)}/${encodeURIComponent(uid)}` : `/api/folders/${encodeURIComponent(uid)}`;
}

function fromResource(resource: Json, address: string): LiveFolder {
  const metadata = isObject(resource.metadata) ? resource.metadata : {};
  const spec = isObject(resource.spec) ? resource.spec : {};
  const parentUid = stringMap(metadata.annotations)[FOLDER_ANNOTATION];
  return {
    uid: typeof metadata.name === "string" ? metadata.name : "",
    title: typeof spec.title === "string" ? spec.title : "",
    ...(parentUid ? { parentUid } : {}),
    labels: stringMap(metadata.labels),
    via: "apis",
    address,
  };
}

function fromLegacy(body: Json, address: string): LiveFolder {
  return {
    uid: typeof body.uid === "string" ? body.uid : "",
    title: typeof body.title === "string" ? body.title : "",
    ...(typeof body.parentUid === "string" && body.parentUid !== "" ? { parentUid: body.parentUid } : {}),
    labels: {},
    via: "legacy",
    address,
    ...(typeof body.version === "number" ? { version: body.version } : {}),
  };
}

/** Read one folder; undefined when there is none with that uid. */
export async function readFolder(client: GrafanaClient, uid: string): Promise<LiveFolder | undefined> {
  const api = await folderApi(client);
  const address = folderPath(api, client.namespace, uid);
  const body = await client.get<Json>(address);
  if (body === undefined) return undefined;
  return api.kind === "apis" ? fromResource(body, address) : fromLegacy(body, address);
}

/** Every folder in the organisation over `/apis`, paged. The legacy API has no labels to list by, so it is not listed. */
export async function listFolders(client: GrafanaClient): Promise<LiveFolder[]> {
  const api = await folderApi(client);
  if (api.kind !== "apis") return [];
  const base = collection(api, client.namespace);
  const out: LiveFolder[] = [];
  let next: string | undefined;
  do {
    const page = await client.get<{ items?: unknown[]; metadata?: { continue?: string } }>(
      `${base}?limit=500${next ? `&continue=${encodeURIComponent(next)}` : ""}`,
    );
    for (const item of page?.items ?? []) {
      if (!isObject(item)) continue;
      const name = isObject(item.metadata) && typeof item.metadata.name === "string" ? item.metadata.name : "";
      if (name) out.push(fromResource(item, `${base}/${encodeURIComponent(name)}`));
    }
    next = page?.metadata?.continue || undefined;
  } while (next);
  return out;
}

/** Send one write; throws {@link GrafanaApiError} on anything but a 2xx. */
export async function send(client: GrafanaClient, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await client.http(method, path, body);
  if (res.status < 200 || res.status >= 300) throw new GrafanaApiError(res.status, method, path, res.json);
  return res.json;
}

function sameLabels(live: Readonly<Record<string, string>>, want: Readonly<Record<string, string>>): boolean {
  return Object.entries(want).every(([k, v]) => live[k] === v);
}

/**
 * Create or update one folder so it matches `plan`, with chant's `labels`
 * on it where the API keeps labels. Unchanged when title, parent and labels
 * already match; nothing is written then.
 */
export async function ensureFolder(
  client: GrafanaClient,
  plan: FolderPlan,
  labels: Readonly<Record<string, string>>,
): Promise<{ action: "created" | "updated" | "unchanged"; address: string; via: "apis" | "legacy" }> {
  const api = await folderApi(client);
  const address = folderPath(api, client.namespace, plan.uid);
  const live = await readFolder(client, plan.uid);
  const sameParent = (live?.parentUid ?? "") === (plan.parentUid ?? "");
  if (api.kind === "apis") {
    if (live && live.title === plan.title && sameParent && sameLabels(live.labels, labels)) return { action: "unchanged", address, via: "apis" };
    // A folder's labels are merged, so a label another tool put there stays.
    const metadata = {
      name: plan.uid,
      labels: { ...(live?.labels ?? {}), ...labels },
      ...(plan.parentUid ? { annotations: { [FOLDER_ANNOTATION]: plan.parentUid } } : {}),
    };
    const resource = { apiVersion: `${FOLDER_GROUP}/${api.version}`, kind: "Folder", metadata, spec: { title: plan.title } };
    if (live) {
      await send(client, "PUT", address, resource);
      return { action: "updated", address, via: "apis" };
    }
    await send(client, "POST", collection(api, client.namespace), resource);
    return { action: "created", address, via: "apis" };
  }
  if (live) {
    if (live.title === plan.title && sameParent) return { action: "unchanged", address, via: "legacy" };
    if (live.title !== plan.title) await send(client, "PUT", address, { title: plan.title, ...(live.version !== undefined ? { version: live.version } : {}), overwrite: true });
    if (!sameParent) await send(client, "POST", `${address}/move`, { parentUid: plan.parentUid ?? "" });
    return { action: "updated", address, via: "legacy" };
  }
  await send(client, "POST", "/api/folders", { uid: plan.uid, title: plan.title, ...(plan.parentUid ? { parentUid: plan.parentUid } : {}) });
  return { action: "created", address, via: "legacy" };
}

/**
 * How many things a folder holds (dashboards, folders, library panels, alert
 * rules), from `GET /api/folders/<uid>/counts`. Grafana 12.4 and 13.2 name
 * the keys differently, so every numeric value is summed.
 */
export async function folderContentCount(client: GrafanaClient, uid: string): Promise<number> {
  const counts = await client.get<Json>(`/api/folders/${encodeURIComponent(uid)}/counts`);
  if (!counts) return 0;
  return Object.values(counts).reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0);
}

/**
 * Delete one folder over `/apis`. Only ever called for a folder that holds
 * nothing: Grafana 12.4 and 13.2 refuse to delete a folder with anything in
 * it over `/apis`, and the applier checks first, so a foreign dashboard in a
 * folder chant made is never removed with it. False when it was already gone.
 */
export async function deleteFolder(client: GrafanaClient, folder: LiveFolder): Promise<boolean> {
  if (folder.via !== "apis") throw new Error(`grafana apply: folder "${folder.uid}" was read over /api/folders, whose delete removes what the folder holds; chant does not delete it`);
  const res = await client.http("DELETE", folder.address);
  if (res.status === 404) return false;
  if (res.status < 200 || res.status >= 300) throw new GrafanaApiError(res.status, "DELETE", folder.address, res.json);
  return true;
}

/**
 * Order folders so a child comes before its parent: the order to delete
 * them in. Parents outside the set count as depth 0.
 */
export function childrenFirst(folders: readonly LiveFolder[]): LiveFolder[] {
  const byUid = new Map(folders.map((f) => [f.uid, f]));
  const depth = (f: LiveFolder, seen = new Set<string>()): number => {
    if (!f.parentUid || seen.has(f.uid)) return 0;
    seen.add(f.uid);
    const parent = byUid.get(f.parentUid);
    return parent ? 1 + depth(parent, seen) : 1;
  };
  return [...folders].sort((a, b) => depth(b) - depth(a) || a.uid.localeCompare(b.uid));
}
