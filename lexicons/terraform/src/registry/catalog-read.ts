/**
 * Reading a registry's release catalog (chant#4599, terragucci#1289 bundle
 * B): `catalog/index.json` beside the registry's files, the document
 * `renderCatalogSite` writes (`@intentius/chant/lifecycle/release-catalog-site`).
 *
 * The request carries the token the CLIs would send the host (chant#4563,
 * `readToken` in ./reader.ts), so a registry behind the edge function's
 * `auth: token` check answers it. Per ruling B (2026-10-27) this reader is
 * how a token-protected catalog is read; the edge function gains no cookie
 * and no open path, and a browser reaches the catalog over the
 * network-private path.
 */
import { credentialsHost, tokenVariable } from "@intentius/chant/terraform/credentials";
import { parseReleaseCatalog, ReleaseCatalogError, type ReleaseCatalog } from "@intentius/chant/lifecycle/release-catalog";
import { readToken, RegistryError, type RegistryFetch, type RegistryReadOptions } from "./reader";

/** Where the catalog sits under a registry's root. */
export const CATALOG_PATH = "catalog/index.json";

/** The catalog URL for a registry: a host (`modules.acme.dev`) or a base URL (`https://modules.acme.dev/` or `https://cdn.acme.dev/registry/`). */
export function catalogUrl(registry: string, scheme: "https" | "http" = "https"): string {
  const base = registry.includes("://") ? registry : `${scheme}://${registry}`;
  return new URL(CATALOG_PATH, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Fetch and validate a registry's catalog. Throws `RegistryError` when the
 * request fails or is refused (naming where a token goes, never a value),
 * and when the answer is not a valid catalog. A registry with no catalog
 * (404) gives null.
 */
export async function readRegistryCatalog(registry: string, options: RegistryReadOptions = {}): Promise<ReleaseCatalog | null> {
  const url = catalogUrl(registry, options.scheme);
  const host = new URL(url).host.toLowerCase();
  const token = readToken(host, options);
  const fetchFn: RegistryFetch = options.fetch ?? ((u, init) => fetch(u, init));
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", redirect: "follow", headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch (e) {
    throw new RegistryError(`${url}: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    const variable = tokenVariable(host);
    const where = variable ? `${variable} or a credentials "${credentialsHost(host)}" block` : `a credentials "${credentialsHost(host) ?? host}" block in credentials.tfrc.json`;
    throw new RegistryError(token ? `${url} answered ${res.status}: the registry refused the token for ${host}` : `${url} answered ${res.status}: the catalog wants a token; set ${where}`);
  }
  if (!res.ok) throw new RegistryError(`${url} answered ${res.status}`);
  try {
    return parseReleaseCatalog(await res.text());
  } catch (e) {
    if (e instanceof ReleaseCatalogError) throw new RegistryError(`${url} is not a release catalog: ${e.problems.slice(0, 3).join("; ")}`);
    throw e;
  }
}
