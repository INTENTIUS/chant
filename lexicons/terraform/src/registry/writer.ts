/**
 * The module registry protocol, written as files a bucket, a directory or a
 * Pages site holds (https://opentofu.org/docs/internals/module-registry-protocol/):
 *
 *   .well-known/terraform.json                  {"modules.v1": "/v1/modules/"}
 *   v1/modules/<ns>/<name>/<system>/versions     every version, oldest first
 *   v1/modules/<ns>/<name>/<system>/<v>/download {"location": ...}
 *   v1/modules/<ns>/<name>/<system>/<v>/<name>-<v>.tar.gz   a tarball download
 *   v1/modules/<ns>/<name>/<system>/<v>/release.json        the commit and content digest
 *
 * The download answer the two CLIs need is a 200 with the JSON body and an
 * `X-Terraform-Get` header naming the same location (terragucci#1287).
 * Terraform reads only the header (hashicorp/terraform
 * internal/registry/client.go:237-250 at v1.14.9 and v1.15.8). OpenTofu reads
 * the body's `location` first and the header when it is empty
 * (opentofu/opentofu internal/registry/client.go:205-237 at v1.12.5 and
 * v1.13.1). A stored file carries no header, so the stored `download` file is
 * the body, and whatever serves it (`downloadAnswer`, the loopback handler in
 * ./serve, an edge function) adds the header from that body.
 *
 * The writer takes the store it writes to, so the bucket clients stay with
 * whoever owns them (chant#4554 moves terragucci's into core).
 */
import { StoreConflict, type StoreCondition } from "../state/object-store";
import { DISCOVERY, MODULES_V1, keyFor, type RegistryAddress } from "./address";
import { compareSemver, formatSemver, parseSemver, type Semver } from "./semver";

/** The header Terraform takes a module's location from. */
export const DOWNLOAD_HEADER = "X-Terraform-Get";

/** The files a registry is written to: a bucket client, a directory, or a test's map. */
export interface RegistryWriteStore {
  /** Writes one object. With `when`, the write must fail with a conflict when the condition no longer holds. */
  put(key: string, body: string | Buffer, contentType?: string, when?: StoreCondition): Promise<unknown>;
  /** One object's body and version tag, or `{}` when there is none. */
  read(key: string): Promise<{ body?: string; etag?: string }>;
}

/** The service discovery document. */
export const discoveryDoc = (): string => `${JSON.stringify({ "modules.v1": MODULES_V1 })}\n`;

/** The protocol's versions answer, oldest first, duplicates and non-versions dropped. */
export function versionsDoc(versions: string[]): string {
  const sorted = [...new Set(versions)]
    .map((v) => parseSemver(v))
    .filter((v): v is Semver => !!v)
    .sort(compareSemver)
    .map(formatSemver);
  return `${JSON.stringify({ modules: [{ versions: sorted.map((version) => ({ version })) }] }, null, 2)}\n`;
}

/** The versions a versions answer lists, or none when it is missing or not the protocol's JSON. */
export function readVersions(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as { modules?: { versions?: { version?: unknown }[] }[] };
    return (doc.modules?.[0]?.versions ?? []).map((v) => v.version).filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** A version's download answer body: the JSON OpenTofu reads. */
export function downloadDoc(location: string): string {
  return `${JSON.stringify({ location })}\n`;
}

/** The location a download body names, or undefined when it names none. */
export function downloadLocation(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const location = (JSON.parse(body) as { location?: unknown }).location;
    return typeof location === "string" && location ? location : undefined;
  } catch {
    return undefined;
  }
}

/** A download answer as a server sends it. */
export interface DownloadAnswer {
  status: 200;
  headers: Record<string, string>;
  body: string;
}

/**
 * The download answer both CLIs install from: status 200, the JSON body with
 * `location`, and `X-Terraform-Get` naming the same location.
 */
export function downloadAnswer(location: string): DownloadAnswer {
  return { status: 200, headers: { "content-type": "application/json", [DOWNLOAD_HEADER]: location }, body: downloadDoc(location) };
}

/** The headers a stored download body is served with, or undefined when the body names no location. */
export function downloadHeaders(body: string | undefined): Record<string, string> | undefined {
  const location = downloadLocation(body);
  return location ? downloadAnswer(location).headers : undefined;
}

/** True for a `.../v1/modules/<ns>/<name>/<system>/<version>/download` path, with or without a leading prefix. */
export const isDownloadPath = (path: string): boolean => /(^|\/)v1\/modules\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/download$/.test(path.split("?")[0]!);

/** What the registry keeps beside a version, so the next publish knows what it holds. */
export interface ReleaseMeta {
  module: string;
  version: string;
  revision: string;
  content: string;
  location: string;
}

/** The registry's files for one version, written in this order: the version is listed last, once all it points at is there. */
export interface VersionFiles {
  tarball?: { key: string; body: Buffer };
  download: { key: string; body: string };
  meta: { key: string; body: string };
}

export interface WriteVersionOptions {
  /** The registry's prefix in its store. */
  prefix?: string;
  /**
   * Whether an error from `put` is a lost conditional write, to be retried.
   * By default chant's `StoreConflict`, or any error named `StoreConflict`
   * (a store from another package with a class of its own).
   */
  isConflict?: (e: unknown) => boolean;
  /** Conditional retries on the versions file before the conflict is thrown. Default 3. */
  retries?: number;
}

const defaultIsConflict = (e: unknown): boolean => e instanceof StoreConflict || (e instanceof Error && (e.name === "StoreConflict" || e.constructor.name === "StoreConflict"));

/** Writes one version: discovery when it differs, the tarball, the download answer, release.json, then the versions list. */
export async function writeVersion(store: RegistryWriteStore, addr: RegistryAddress, version: Semver, files: VersionFiles, options: WriteVersionOptions = {}): Promise<void> {
  const discovery = discoveryDoc();
  const discoKey = keyFor(options.prefix, DISCOVERY);
  const disco = await store.read(discoKey);
  if (disco.body !== discovery) await store.put(discoKey, discovery, "application/json");
  if (files.tarball) await store.put(files.tarball.key, files.tarball.body, "application/gzip");
  await store.put(files.download.key, files.download.body, "application/json");
  await store.put(files.meta.key, files.meta.body, "application/json");
  const key = keyFor(options.prefix, `${addr.path}/versions`);
  const isConflict = options.isConflict ?? defaultIsConflict;
  const retries = options.retries ?? 3;
  // Read, add, write only over the copy read: two publishes at once cannot drop each other's version.
  for (let attempt = 0; ; attempt++) {
    const held = await store.read(key);
    const when: StoreCondition | undefined = held.body === undefined ? { ifNoneMatch: "*" } : held.etag ? { ifMatch: held.etag } : undefined;
    try {
      await store.put(key, versionsDoc([...readVersions(held.body), formatSemver(version)]), "application/json", when);
      return;
    } catch (e) {
      if (!isConflict(e) || attempt >= retries) throw e;
    }
  }
}
