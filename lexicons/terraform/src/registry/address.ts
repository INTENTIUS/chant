/**
 * Where a module sits in a Terraform module registry, and how a registry
 * source (`<host>/<namespace>/<name>/<system>`) is split into those parts.
 * Lifted from terragucci's `publish/registry.ts` (18f6431595) for chant#4565.
 * No Node imports, so an edge function can carry it.
 */

export const DISCOVERY = ".well-known/terraform.json";
export const MODULES_V1 = "/v1/modules/";
export const DEFAULT_SYSTEM = "generic";

/** A registry namespace or module name: letters, digits, `-` and `_`, starting and ending on a letter or digit. */
export const REGISTRY_NAME = /^[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?$/;
/** A registry module's system (its target provider): lower-case letters and digits. */
export const REGISTRY_SYSTEM = /^[0-9a-z]{1,64}$/;

/** Where a module is in the registry. */
export interface RegistryAddress {
  namespace: string;
  name: string;
  system: string;
  /** `<host>/<namespace>/<name>/<system>`, the source a root writes. */
  source: string;
  /** The module's directory under the registry root: `v1/modules/<namespace>/<name>/<system>`. */
  path: string;
}

/** What placing a module needs from a registry's settings. */
export interface RegistryPlacement {
  /** The registry's base URL; its host is what sources name. */
  url: string;
  namespace: string;
  /** A namespace per path prefix, the longest prefix winning. */
  namespaces?: Record<string, string>;
  system?: string;
}

/** A module name the protocol cannot carry. */
export class RegistryNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryNameError";
  }
}

/** The host a registry's sources name: its URL without the scheme, lower-cased. */
export const registryHost = (reg: Pick<RegistryPlacement, "url">): string => new URL(reg.url).host.toLowerCase();

/** The namespace a module's path goes under: the longest `namespaces` prefix it starts with, else `namespace`. */
export function namespaceFor(reg: Pick<RegistryPlacement, "namespace" | "namespaces">, rel: string): string {
  let best: { prefix: string; ns: string } | undefined;
  for (const [prefix, ns] of Object.entries(reg.namespaces ?? {})) {
    const p = prefix.replace(/^\.\//, "");
    const dir = p.endsWith("/") ? p : `${p}/`;
    if ((rel.startsWith(dir) || rel === p.replace(/\/+$/, "")) && (!best || p.length > best.prefix.length)) best = { prefix: p, ns };
  }
  return best?.ns ?? reg.namespace;
}

/** A module's place in the registry: its namespace, its name (the last segment of its path) and its system. */
export function registryAddress(reg: RegistryPlacement, rel: string): RegistryAddress {
  const namespace = namespaceFor(reg, rel);
  const name = rel.replace(/\/+$/, "").split("/").pop() ?? "";
  const system = reg.system ?? DEFAULT_SYSTEM;
  if (!REGISTRY_NAME.test(name)) throw new RegistryNameError(`${rel}: a registry module's name is letters, digits, - and _, and ${JSON.stringify(name)} is not; rename the directory`);
  return { namespace, name, system, source: `${registryHost(reg)}/${namespace}/${name}/${system}`, path: `v1/modules/${namespace}/${name}/${system}` };
}

/** A registry source split into its parts. */
export interface RegistrySource {
  host: string;
  namespace: string;
  name: string;
  system: string;
}

/**
 * A registry source split into its host and module, or undefined when the
 * source is not one: `host/ns/name/system`, with an optional `//subdir` and
 * query. The host must look like one (a dot, a port, or `localhost`), so a
 * three-part public registry source with no host is not taken for one.
 */
export function parseRegistrySource(source: string): RegistrySource | undefined {
  const base = source.split("?")[0]!.split("//")[0]!;
  const m = /^([a-z0-9.-]+(?::\d+)?)\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(base);
  if (!m || (!m[1]!.includes(".") && !m[1]!.includes(":") && m[1] !== "localhost")) return undefined;
  return { host: m[1]!.toLowerCase(), namespace: m[2]!, name: m[3]!, system: m[4]! };
}

/** A key under a registry's prefix in its bucket or directory. */
export const keyFor = (prefix: string | undefined, path: string): string => {
  const p = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/${path}` : path;
};

/** The tarball's name beside its version. */
export const tarballName = (addr: Pick<RegistryAddress, "name">, version: string): string => `${addr.name}-${version}.tar.gz`;
