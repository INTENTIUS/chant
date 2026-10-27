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
 *
 * Every request to the registry's host carries the token the CLIs would send
 * it (chant#4563): `TF_TOKEN_<host>`, else the CLI config's or
 * credentials.tfrc.json's `credentials` block, found by core's
 * `terraform/credentials` reader. The token goes in the `Authorization`
 * header and nowhere else; an error names the variable to set, never a value.
 */
import { gunzipSync } from "node:zlib";
import { credentialsHost, terraformToken, tokenVariable, type CredentialsOptions } from "@intentius/chant/terraform/credentials";
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
  /**
   * The bearer token sent to the registry's host. Default: the one the CLIs
   * would send (`TF_TOKEN_<host>`, then the credentials files). `false` sends none.
   */
  token?: string | false;
  /** Where the default token lookup reads (a test passes its own env and files). */
  credentials?: CredentialsOptions;
}

/** The token a read sends to a host, by the options. */
export const readToken = (host: string, o: RegistryReadOptions): string | undefined => (o.token === false ? undefined : (o.token ?? terraformToken(host, o.credentials)));

const httpGet = async (fetchFn: RegistryFetch, url: string, token?: string): Promise<Response> => {
  try {
    return await fetchFn(url, { method: "GET", redirect: "follow", ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    throw new RegistryError(`${url}: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
  }
};

/** The error for a status that is not OK, saying where a token goes when the registry refused one. */
const answered = (url: string, status: number, host: string, token: string | undefined): RegistryError => {
  if (status !== 401 && status !== 403) return new RegistryError(`${url} answered ${status}`);
  const variable = tokenVariable(host);
  const where = variable ? `${variable} or a credentials "${credentialsHost(host)}" block` : `a credentials "${credentialsHost(host) ?? host}" block in credentials.tfrc.json`;
  return new RegistryError(token ? `${url} answered ${status}: the registry refused the token for ${host}` : `${url} answered ${status}: the registry wants a token; set ${where}`);
};

const optionsOf = (o: RegistryFetch | RegistryReadOptions | undefined): RegistryReadOptions => (typeof o === "function" ? { fetch: o } : (o ?? {}));

/** The modules.v1 base a host's service discovery names, ending in `/`. */
export async function modulesBase(host: string, options?: RegistryFetch | RegistryReadOptions): Promise<string> {
  const o = optionsOf(options);
  const disco = `${o.scheme ?? "https"}://${host}/${DISCOVERY}`;
  const token = readToken(host, o);
  const res = await httpGet(o.fetch ?? globalFetch, disco, token);
  if (!res.ok) throw answered(disco, res.status, host, token);
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
  const token = readToken(s.host, o);
  const url = `${await modulesBase(s.host, { ...o, token: token ?? false })}${s.namespace}/${s.name}/${s.system}/versions`;
  const res = await httpGet(o.fetch ?? globalFetch, url, token);
  if (res.status === 404) return [];
  if (!res.ok) throw answered(url, res.status, s.host, token);
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
  const token = readToken(s.host, o);
  const url = `${await modulesBase(s.host, { ...o, token: token ?? false })}${s.namespace}/${s.name}/${s.system}/${version}/download`;
  const res = await httpGet(o.fetch ?? globalFetch, url, token);
  if (res.status === 404) throw new RegistryError(`${s.host}/${s.namespace}/${s.name}/${s.system} has no version ${version}`);
  if (!res.ok) throw answered(url, res.status, s.host, token);
  const reads = o.reads ?? "either";
  let location = await locationFromAnswer(res, reads);
  if (!location) {
    throw new RegistryError(reads === "terraform" ? `${url} sends no ${DOWNLOAD_HEADER} header, and Terraform reads only the header` : `${url} names no location`);
  }
  if (/^(\.{0,2}\/)/.test(location)) location = new URL(location, url).toString();
  return location;
}

/**
 * The module archive a tarball location holds, uncompressed: the bytes a
 * release's digest is of. The host's token goes along only when the location
 * has no query string; a signed URL carries its own grant, and a bucket
 * refuses a request that has both a signature and an `Authorization` header.
 */
export async function fetchTarball(location: string, options?: RegistryFetch | RegistryReadOptions): Promise<Buffer> {
  const o = optionsOf(options);
  const u = new URL(location);
  const token = u.search || (u.protocol !== "https:" && u.protocol !== "http:") ? undefined : readToken(u.host, o);
  const res = await httpGet(o.fetch ?? globalFetch, location, token);
  if (!res.ok) throw answered(location, res.status, u.host, token);
  const body = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(body);
  } catch {
    throw new RegistryError(`${location} is not a gzip archive`);
  }
}
