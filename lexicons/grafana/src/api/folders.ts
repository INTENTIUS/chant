/**
 * Folders: the one place a build's folders become uids and parents, and how
 * the API applier (#2948) and observation read and write them.
 *
 * ## What a build declares
 *
 * A dashboard names its folder as a path (`Dashboard.folder:
 * "Platform/Kubernetes"`) or as a `Folder` (../folder.ts), and a `Folder`
 * may be declared on its own. {@link resolveFolders} turns all of it into
 * one {@link FolderPlan} per folder: every level of every path, the uid a
 * `Folder` pins or {@link folderUidFor} of its path, and its parent's uid.
 * The build calls it and writes the result to its index (`folders`, and a
 * `folderUid` on each dashboard); the applier reads the index and calls it
 * again, which also covers an index written before folders were listed.
 * Two folders at one path with different uids, or two paths with one uid,
 * throw: no delivery could make both.
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
import { folderLevels, folderUidFor } from "../folder";

export { folderUidFor };

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
  /** Its titles from the root, joined with `/`: the directory file provisioning reads it from. */
  readonly path?: string;
}

/** A folder as Grafana holds it. */
export interface LiveFolder {
  readonly uid: string;
  readonly title: string;
  readonly parentUid?: string;
  /** `metadata.labels`; empty on the legacy API. */
  readonly labels: Readonly<Record<string, string>>;
  /** `metadata.annotations`; empty on the legacy API. */
  readonly annotations?: Readonly<Record<string, string>>;
  readonly via: "apis" | "legacy";
  /** The request path it lives at. */
  readonly address: string;
  /** The legacy folder's `version`, which its update needs. */
  readonly version?: number;
}

/** The folders a build resolves to, and the uid of each path. */
export interface ResolvedFolders {
  /** One per folder, sorted by path, so a parent comes before its children. */
  readonly folders: FolderPlan[];
  /** The uid of the folder at `path` (any spelling `folderLevels` reads the same); undefined for the General folder. */
  uidOf(path: string | undefined): string | undefined;
}

/**
 * Every folder a build needs, with its uid and parent: the folders declared
 * with a uid (`Folder`s, or dashboards already resolved), and every level of
 * every path a dashboard names. A level no declaration pins gets
 * {@link folderUidFor} of its path. Throws when two declarations put
 * different uids at one path, and when two paths would get one uid unless
 * `duplicateUids` is `keep`: the build keeps both and GRAF104 reports them,
 * since file provisioning, which gives folders uids of its own, can still
 * deliver them.
 */
export function resolveFolders(
  input: { declared?: Iterable<{ uid: string; path: string }>; paths?: Iterable<string | undefined> },
  options: { duplicateUids?: "throw" | "keep" } = {},
): ResolvedFolders {
  const byPath = new Map<string, string>();
  const key = (path: string) => folderLevels(path).join("/");
  for (const d of input.declared ?? []) {
    const path = key(d.path);
    if (path === "") continue;
    const prior = byPath.get(path);
    if (prior !== undefined && prior !== d.uid) {
      throw new Error(`grafana: the folder "${path}" is declared with the uids "${prior}" and "${d.uid}"; a folder has one uid`);
    }
    byPath.set(path, d.uid);
  }
  const addPath = (path: string) => {
    const levels = folderLevels(path);
    for (let i = 1; i <= levels.length; i++) {
      const prefix = levels.slice(0, i).join("/");
      if (!byPath.has(prefix)) byPath.set(prefix, folderUidFor(prefix));
    }
  };
  for (const path of [...byPath.keys()]) addPath(path);
  for (const path of input.paths ?? []) if (path) addPath(path);

  const byUid = new Map<string, string>();
  const folders: FolderPlan[] = [];
  for (const path of [...byPath.keys()].sort((a, b) => a.localeCompare(b))) {
    const uid = byPath.get(path)!;
    const seen = byUid.get(uid);
    if (seen !== undefined && options.duplicateUids !== "keep") throw new Error(`grafana: the folders "${seen}" and "${path}" would both get the uid "${uid}"; give one a Folder with its own uid`);
    byUid.set(uid, path);
    const levels = path.split("/");
    const parentUid = levels.length > 1 ? byPath.get(levels.slice(0, -1).join("/")) : undefined;
    folders.push({ uid, title: levels[levels.length - 1], ...(parentUid ? { parentUid } : {}), path });
  }
  return { folders, uidOf: (path) => (path === undefined ? undefined : byPath.get(key(path))) };
}

/**
 * The folders a set of dashboards needs: every level of every folder they
 * name, sorted by path. A dashboard that already carries its `folderUid`
 * pins its folder's uid.
 */
export function foldersForDashboards(dashboards: Iterable<{ folder?: string; folderUid?: string }>): FolderPlan[] {
  const list = [...dashboards];
  return resolveFolders({
    declared: list.filter((d) => d.folder && d.folderUid).map((d) => ({ uid: d.folderUid!, path: d.folder! })),
    paths: list.map((d) => d.folder),
  }).folders;
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
  const annotations = stringMap(metadata.annotations);
  const parentUid = annotations[FOLDER_ANNOTATION];
  return {
    uid: typeof metadata.name === "string" ? metadata.name : "",
    title: typeof spec.title === "string" ? spec.title : "",
    ...(parentUid ? { parentUid } : {}),
    labels: stringMap(metadata.labels),
    annotations,
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

/**
 * The path of the folder with this uid, its titles from the root joined with
 * `/`, the form `Dashboard.folder` takes. One read per folder per client;
 * undefined when the folder, or one of its parents, cannot be found.
 */
export async function liveFolderPath(client: GrafanaClient, uid: string): Promise<string | undefined> {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = uid; at; ) {
    // Grafana's own limit on nesting is 8 levels; a longer chain is a cycle.
    if (seen.has(at) || seen.size > 8) return undefined;
    seen.add(at);
    const id: string = at;
    const folder = await client.once(`folder:${id}`, () => readFolder(client, id));
    if (!folder) return undefined;
    titles.unshift(folder.title);
    at = folder.parentUid;
  }
  return titles.join("/");
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
