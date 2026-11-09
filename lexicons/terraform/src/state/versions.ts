/**
 * A root's state read by version: for chant core's state export (#4762,
 * `@intentius/chant/state-export`), for what an apply leaves, and for an
 * audit of every version a store keeps (#4793). The reads are the stores'
 * (./store.ts):
 *
 *   s3       bucket versioning: the object's `x-amz-version-id`
 *   gcs      object versioning: a version is a generation
 *   azurerm  blob versioning: the blob's `x-ms-version-id`; with none, the
 *            snapshots the backend takes when it sets `snapshot = true`, and
 *            a request for the current version takes one, whose id names it
 *   http     a GitLab-managed state (./gitlab.ts): GitLab keeps each version
 *            by its serial, so the version id is the serial
 *   local    keeps only the latest state
 *
 * A backend chant reads no versions of is named by what it keeps: pg,
 * kubernetes, consul and an http backend other than GitLab's keep no
 * history (each write replaces the state in place), and any other may keep
 * versions chant does not read. Nothing here writes a state; the one write
 * is the azurerm snapshot above.
 *
 * Lifted from terragucci's `backend.ts`: the `version`, `hasVersion`,
 * `readVersion` and `isAt` of its stores, `keepsHistory`, `stateVersion` and
 * `listStateVersions`, so terragucci deletes its copy.
 */
import type { StateVersion, StateVersionSource } from "@intentius/chant/state-export";
import { AzureBlobClient, azureFromEnv, GcsClient, gcsFromEnv, S3Client, s3FromEnv, type ObjectVersion } from "@intentius/chant/object-store";
import { literal, stateAddress } from "../compose/state-address";
import { initialisedBackend, isRefused, readableStateObject, stateLocation, type InitialisedBackend, type StateObject, type StateStoreWords } from "./backend";
import { isGitLabAddress, type GitLabStateStore } from "./gitlab";
import { StoreError, type StoreFetch } from "./object-store";
import { stateStore } from "./store";

/** What the version reads cover, for a refusal. */
export const READS_VERSIONS = "a state export reads versions of s3, gcs and azurerm states and GitLab-managed state";

/**
 * A root's state as a version source, or why it has none: a refused backend,
 * or a local state, which keeps no versions. With `pin: false` an azurerm
 * blob that keeps no versions names none for its current state, where the
 * default takes a snapshot to name it.
 */
export function stateVersionSource(o: StateObject, fetchFn?: StoreFetch, options: { pin?: boolean } = {}): StateVersionSource | { refused: string } {
  if (isRefused(o)) return { refused: o.reason };
  if (o.backend === "local") return { refused: `the state is a local file, ${stateLocation(o)}, which keeps no versions; ${READS_VERSIONS}` };
  const store = stateStore(o, "", fetchFn);
  const pin = options.pin ?? true;
  return {
    location: store.location,
    current: () => store.version(pin),
    hasVersion: (id) => store.hasVersion(id),
    readVersion: (id) => store.readVersion(id),
  };
}

/** A GitLab-managed state as a version source: the version id is the serial. */
export function gitlabVersionSource(store: GitLabStateStore): StateVersionSource {
  return {
    location: store.location,
    current: (): Promise<StateVersion> => store.version(),
    hasVersion: (id) => store.hasVersion(id),
    readVersion: (id) => store.readVersion(id),
  };
}

/**
 * Why a backend keeps no history, for the types that keep none: each write
 * replaces the state in place. GitLab's http backend keeps each version by
 * serial, so an http backend is in this list only when its address is not
 * GitLab's state API.
 */
export const NO_HISTORY: Readonly<Record<string, string>> = {
  pg: "a pg backend keeps one row per workspace, which each write replaces",
  kubernetes: "a kubernetes backend keeps one Secret per workspace, which each write replaces",
  consul: "a consul backend keeps one key per workspace, which each write replaces",
  http: "an http backend keeps what its server holds at the address and names no versions",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Whether the backend keeps no history of the state: false for one that keeps none, undefined when it may keep some. The address of an http backend is the recorded one, else TF_HTTP_ADDRESS. */
export function keepsHistory(b: InitialisedBackend, env: NodeJS.ProcessEnv = {}): false | undefined {
  if (!(b.type in NO_HISTORY)) return undefined;
  if (b.type === "http" && isGitLabAddress(str(b.config.address) ?? env.TF_HTTP_ADDRESS)) return undefined;
  return false;
}

/** The state's address (../compose/state-address.ts) from the configuration init recorded, credentials left out. */
export function recordedAddress(b: InitialisedBackend): string | undefined {
  const workspaces = Array.isArray(b.config.workspaces) ? b.config.workspaces[0] : b.config.workspaces;
  const get = (n: string): string | null | undefined => literal(b.config[n] ?? (workspaces && typeof workspaces === "object" ? (workspaces as Record<string, unknown>)[n] : undefined));
  const a = stateAddress(b.type, get, "");
  return "key" in a ? a.key : undefined;
}

/** The version of a root's state an apply leaves, as a run records it. */
export interface RootStateVersion {
  /** The backend the root initialised: `s3`, `local`, `gcs` and so on. */
  backend: string;
  /** Where the state is: `s3://<bucket>/<key>`, `gs://<bucket>/<key>`, `az://<account>/<container>/<key>`, a GitLab state's address, the local file's path, or another backend's address. */
  location?: string;
  /** The backend's id for this version: an S3 version id, a GCS generation, an Azure blob version id or snapshot time, a GitLab serial. Absent when the backend keeps no versions or none could be read. */
  version_id?: string;
  /** `on`: the backend keeps each version; `off`: it keeps only the latest; `unknown`: chant could not tell. */
  versioning: "on" | "off" | "unknown";
  /** Why the version could not be read, or what `off` means for this backend. */
  note?: string;
}

export interface ReadStateVersionOptions {
  /** The calls the store makes. Default the global fetch. */
  fetch?: StoreFetch;
  /** Stands in for the backend `init` recorded: a Terragrunt unit's, from its evaluated `remote_state` block. */
  backend?: InitialisedBackend;
  /** The product's words for a credentials refusal (`StateStoreWords`). */
  words?: StateStoreWords;
}

/**
 * The version of the state a root's backend holds now, from the object's
 * metadata (#4793). An azurerm blob that keeps snapshots and no versions
 * gets a snapshot, whose time names the version. Never throws: a version
 * that cannot be read is `unknown`, with why.
 */
export async function readStateVersion(dir: string, env: NodeJS.ProcessEnv = process.env, options: ReadStateVersionOptions = {}): Promise<RootStateVersion> {
  const recorded = options.backend ?? initialisedBackend(dir, env);
  const o = readableStateObject(dir, env, recorded, options.words);
  if (isRefused(o)) {
    const b = recorded ?? { type: "local", config: {} };
    const location = recordedAddress(b);
    const at = location ? { location } : {};
    if (o.refused !== "backend") return { backend: o.backend, ...at, versioning: "unknown", note: o.reason };
    if (keepsHistory(b, env) === false) return { backend: b.type, ...at, versioning: "off", note: NO_HISTORY[b.type] };
    return { backend: b.type, ...at, versioning: "unknown", note: `a ${b.type} backend can keep versions of the state, which chant does not read` };
  }
  const location = stateLocation(o)!;
  if (o.backend === "local") return { backend: "local", location, versioning: "off", note: "a local backend keeps only the latest state" };
  try {
    const v = await stateStore(o, dir, options.fetch).version(true);
    if (!v.exists) return { backend: o.backend, location, versioning: "unknown", note: o.backend === "http" ? "GitLab holds no state at this address" : `the state object is not in the ${o.backend === "azurerm" ? "container" : "bucket"}` };
    if (v.versionId) return { backend: o.backend, location, version_id: v.versionId, versioning: "on" };
    if (v.off) return { backend: o.backend, location, versioning: "off", note: v.off };
    return { backend: o.backend, location, versioning: "unknown", note: "the store gave no version id" };
  } catch (e) {
    return { backend: o.backend, location, versioning: "unknown", note: (e as Error).message };
  }
}

/** What a state's store lists of its versions: each one, newest first; why none are listed; or why the list could not be read. */
export type StateVersionList = { versions: ObjectVersion[] } | { skipped: string } | { error: string };

/**
 * Every version a state's store keeps, by the state's location as a run
 * recorded it (`s3://<bucket>/<key>`, `gs://<bucket>/<key>`,
 * `az://<account>/<container>/<key>`), from the store's list of the
 * object's versions with the job's own identity: ids and times, never a
 * state's contents (#4793). A GitLab state is skipped, since GitLab's state
 * API lists no versions, and so is any other location, with why. Throws
 * only what is neither a store's error nor a failed call.
 */
export async function listStateVersions(location: string, env: NodeJS.ProcessEnv = process.env, options: { fetch?: StoreFetch; words?: StateStoreWords } = {}): Promise<StateVersionList> {
  const m = /^(s3|gs|az):\/\/([^/]+)\/(.+)$/.exec(location);
  if (!m) {
    if (isGitLabAddress(location)) return { skipped: "GitLab's state API lists no versions of a state" };
    return { skipped: "chant lists the versions of s3, gcs and azurerm states only" };
  }
  const [, scheme, bucket, rest] = m as unknown as [string, string, string, string];
  const words = { setting: "the state bucket", sessionName: "chant-state", ...options.words };
  try {
    let versions: ObjectVersion[];
    if (scheme === "s3") versions = await new S3Client(s3FromEnv({ bucket, ...words }, env), options.fetch).listVersions(rest);
    else if (scheme === "gs") versions = await new GcsClient(gcsFromEnv({ bucket, ...words }, env), options.fetch).listVersions(rest);
    else {
      const [container, ...key] = rest.split("/");
      if (!container || key.length === 0) return { skipped: `${location} names no blob` };
      versions = await new AzureBlobClient(azureFromEnv({ account: bucket, container, ...words }, env), options.fetch).listVersions(key.join("/"));
    }
    return versions.length > 0 ? { versions } : { skipped: "the store lists no versions of the state" };
  } catch (e) {
    if (!(e instanceof StoreError) && !(e instanceof TypeError)) throw e;
    return { error: e.message };
  }
}
