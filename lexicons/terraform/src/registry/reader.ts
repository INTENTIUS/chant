/**
 * Reading a module registry the way the CLIs do: service discovery, the
 * versions list, a version's download location, and a tarball's bytes.
 * Lifted from terragucci's `publish/registry.ts` (18f6431595) for chant#4565.
 *
 * `registryLocation` reads the download answer in one of three ways:
 * `terraform` takes only the `X-Terraform-Get` header (200 or 204), `tofu`
 * takes the JSON body's `location` on a 200 and the header otherwise, and the
 * default takes either, header first. A test that wants to know whether
 * Terraform can install from a registry asks with `reads: "terraform"`.
 */
import { gunzipSync } from "node:zlib";
import { DISCOVERY, parseRegistrySource } from "./address";
import { DOWNLOAD_HEADER, readVersions } from "./writer";

/** The fetch the reader calls: the global fetch's shape. */
export type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;

const globalFetch: RegistryFetch = (url, init) => fetch(url, init);

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** How a download answer is read. */
export type DownloadReader = "terraform" | "tofu" | "either";

export interface RegistryReadOptions {
  fetch?: RegistryFetch;
  /** The URL scheme service discovery is fetched over. Default https, as both CLIs use. */
  scheme?: "https" | "http";
}

const httpGet = async (fetchFn: RegistryFetch, url: string): Promise<Response> => {
  try {
    return await fetchFn(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    throw new RegistryError(`${url}: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
  }
};

const optionsOf = (o: RegistryFetch | RegistryReadOptions | undefined): RegistryReadOptions => (typeof o === "function" ? { fetch: o } : (o ?? {}));

/** The modules.v1 base a host's service discovery names, ending in `/`. */
export async function modulesBase(host: string, options?: RegistryFetch | RegistryReadOptions): Promise<string> {
  const o = optionsOf(options);
  const disco = `${o.scheme ?? "https"}://${host}/${DISCOVERY}`;
  const res = await httpGet(o.fetch ?? globalFetch, disco);
  if (!res.ok) throw new RegistryError(`${disco} answered ${res.status}`);
  let base: unknown;
  try {
    base = ((await res.json()) as Record<string, unknown>)["modules.v1"];
  } catch {
    throw new RegistryError(`${disco} is not JSON`);
  }
  if (typeof base !== "string") throw new RegistryError(`${disco} names no modules.v1`);
  const url = new URL(base, disco).toString();
  return url.endsWith("/") ? url : `${url}/`;
}

/** Every version a registry lists for a module; none when it has no versions file. */
export async function registryVersions(source: string, options?: RegistryFetch | RegistryReadOptions): Promise<string[]> {
  const o = optionsOf(options);
  const s = parseRegistrySource(source);
  if (!s) throw new RegistryError(`${source} is not a registry source`);
  const url = `${await modulesBase(s.host, o)}${s.namespace}/${s.name}/${s.system}/versions`;
  const res = await httpGet(o.fetch ?? globalFetch, url);
  if (res.status === 404) return [];
  if (!res.ok) throw new RegistryError(`${url} answered ${res.status}`);
  return readVersions(await res.text());
}

export interface RegistryLocationOptions extends RegistryReadOptions {
  /** Which CLI's reading to follow. Default `either`. */
  reads?: DownloadReader;
}

/** The location a download answer gives, read as `reads` says, or undefined when it gives none that way. */
export async function locationFromAnswer(res: Response, reads: DownloadReader = "either"): Promise<string | undefined> {
  const header = res.headers.get(DOWNLOAD_HEADER) || undefined;
  if (reads === "terraform") return res.status === 200 || res.status === 204 ? header : undefined;
  let body: string | undefined;
  if (res.status === 200) {
    try {
      const doc = (await res.json()) as { location?: unknown };
      if (typeof doc.location === "string" && doc.location) body = doc.location;
    } catch {
      // OpenTofu fails on a 200 whose body is not JSON, before it looks at the header.
      if (reads === "tofu") return undefined;
    }
  }
  return reads === "tofu" ? (body ?? header) : (header ?? body);
}

/** Where a registry says one version is, resolved against the download URL when it is relative. */
export async function registryLocation(source: string, version: string, options?: RegistryFetch | RegistryLocationOptions): Promise<string> {
  const o = optionsOf(options) as RegistryLocationOptions;
  const s = parseRegistrySource(source);
  if (!s) throw new RegistryError(`${source} is not a registry source`);
  const url = `${await modulesBase(s.host, o)}${s.namespace}/${s.name}/${s.system}/${version}/download`;
  const res = await httpGet(o.fetch ?? globalFetch, url);
  if (res.status === 404) throw new RegistryError(`${s.host}/${s.namespace}/${s.name}/${s.system} has no version ${version}`);
  if (!res.ok) throw new RegistryError(`${url} answered ${res.status}`);
  const reads = o.reads ?? "either";
  let location = await locationFromAnswer(res, reads);
  if (!location) {
    throw new RegistryError(reads === "terraform" ? `${url} sends no ${DOWNLOAD_HEADER} header, and Terraform reads only the header` : `${url} names no location`);
  }
  if (/^(\.{0,2}\/)/.test(location)) location = new URL(location, url).toString();
  return location;
}

/** The module archive a tarball location holds, uncompressed: the bytes a release's digest is of. */
export async function fetchTarball(location: string, options?: RegistryFetch | RegistryReadOptions): Promise<Buffer> {
  const o = optionsOf(options);
  const res = await httpGet(o.fetch ?? globalFetch, location);
  if (!res.ok) throw new RegistryError(`${location} answered ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(body);
  } catch {
    throw new RegistryError(`${location} is not a gzip archive`);
  }
}
