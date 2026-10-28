/**
 * Registry proxies (chant#4606, terragucci#1290 bundle C): an Artifactory
 * remote or virtual repository, or a Nexus proxy or group repository,
 * standing in front of an upstream registry, so a source written through
 * one and the plain upstream source compare equal, and reads go through the
 * proxy. The shapes are the ones terragucci#1299's research found:
 *
 *   Artifactory   <host>/<repo>__<ns>/<name>/<system>   module, the repository key joined to the namespace by `__`
 *                 <host>/<repo>__<ns>/<type>            provider, the same joiner
 *   Nexus         <label>/<ns>/<name>/<system>          behind a CLI `host "<label>"` block whose services
 *                                                       point at the proxy repository; the label is usually
 *                                                       the upstream itself (`host "registry.terraform.io"`)
 *
 * An entry names the host sources through the proxy write, the Artifactory
 * repository key when there is one, and the upstream it stands for
 * (registry.terraform.io unless set). A Nexus entry carries the repository's
 * modules.v1 URL, which reads use in place of the label's discovery, as the
 * CLI's host block does. No Node imports, so an edge function can carry it.
 */
import { parseRegistrySource } from "./address";

/** The upstream a proxy stands for when an entry names none. */
export const DEFAULT_PROXY_UPSTREAM = "registry.terraform.io";

/** One registry proxy. */
export interface RegistryProxy {
  /** The host sources through the proxy name: Artifactory's host, or the label of a Nexus host block. */
  host: string;
  /** Artifactory: the remote or virtual repository's key, joined to the namespace with `__`. Absent for Nexus. */
  repo?: string;
  /** The registry host the proxy stands for. Default registry.terraform.io. */
  upstream?: string;
  /**
   * The modules.v1 URL a CLI host block gives the label (a Nexus proxy or
   * group repository's `<url>/repository/<repo>/v1/modules/`), read in
   * place of the label's service discovery.
   */
  modules?: string;
  /** The providers.v1 URL of the same host block, when reads of providers go through it. */
  providers?: string;
}

/** The `__` an Artifactory source joins its repository key and namespace with. */
export const ARTIFACTORY_JOINER = "__";

/** A proxy entry for an Artifactory remote or virtual Terraform repository. */
export const artifactoryProxy = (host: string, repo: string, upstream?: string): RegistryProxy => ({ host: host.toLowerCase(), repo, ...(upstream ? { upstream: upstream.toLowerCase() } : {}) });

/**
 * A proxy entry for a Nexus proxy or group Terraform repository at `url`.
 * The label defaults to the upstream, as Sonatype's docs write the host
 * block (`host "registry.terraform.io"`), so plain sources go through it.
 */
export function nexusProxy(o: { url: string; repo: string; upstream?: string; host?: string }): RegistryProxy {
  const base = o.url.replace(/\/+$/, "");
  const upstream = (o.upstream ?? DEFAULT_PROXY_UPSTREAM).toLowerCase();
  const repo = encodeURIComponent(o.repo);
  return { host: (o.host ?? upstream).toLowerCase(), upstream, modules: `${base}/repository/${repo}/v1/modules/`, providers: `${base}/repository/${repo}/v1/providers/` };
}

const upstreamOf = (p: RegistryProxy): string => (p.upstream ?? DEFAULT_PROXY_UPSTREAM).toLowerCase();
const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The bare labels the proxies use as hosts, so a source starting with one parses as a registry source. */
export const proxyLabels = (proxies: readonly RegistryProxy[] = []): string[] => proxies.map((p) => p.host);

/** A namespace through an Artifactory proxy without its `<repo>__`, or undefined when it does not carry that repository. */
function unjoin(p: RegistryProxy, namespace: string): string | undefined {
  if (!p.repo) return namespace;
  const prefix = `${p.repo}${ARTIFACTORY_JOINER}`;
  return namespace.toLowerCase().startsWith(prefix.toLowerCase()) && namespace.length > prefix.length ? namespace.slice(prefix.length) : undefined;
}

/**
 * The upstream registry source a module source written through a proxy
 * stands for, `<upstream>/<ns>/<name>/<system>` with any `//subdir` kept and
 * the query dropped, and the proxy it went through. Undefined for a source
 * through none of them. A Nexus label that is the upstream itself gives the
 * source back at the upstream.
 */
export function moduleThroughProxy(source: string, proxies: readonly RegistryProxy[] = []): { proxy: RegistryProxy; upstream: string } | undefined {
  if (proxies.length === 0) return undefined;
  const written = source.trim().split("?")[0]!;
  const [base, ...sub] = written.split("//");
  const s = parseRegistrySource(base!, proxyLabels(proxies));
  if (!s) return undefined;
  for (const p of proxies) {
    if (!sameHost(p.host, s.host)) continue;
    const ns = unjoin(p, s.namespace);
    if (ns === undefined) continue;
    const upstream = [`${upstreamOf(p)}/${ns}/${s.name}/${s.system}`, ...sub].join("//");
    return { proxy: p, upstream };
  }
  return undefined;
}

/**
 * The upstream provider address a provider source written through a proxy
 * stands for, `<upstream>/<ns>/<type>` in lower case. Undefined for a
 * source through none of them.
 */
export function providerThroughProxy(source: string, proxies: readonly RegistryProxy[] = []): { proxy: RegistryProxy; upstream: string } | undefined {
  const parts = source.trim().toLowerCase().split("/");
  if (parts.length !== 3) return undefined;
  const [host, namespace, type] = parts as [string, string, string];
  for (const p of proxies) {
    if (!sameHost(p.host, host)) continue;
    const ns = unjoin(p, namespace);
    if (ns === undefined || !ns || !type) continue;
    return { proxy: p, upstream: `${upstreamOf(p)}/${ns}/${type}` };
  }
  return undefined;
}

/**
 * Where a read of a module at `host/<ns>/<name>/<system>` goes when a proxy
 * stands for `host`: the host and namespace the proxy names it by, and the
 * modules.v1 URL to read in place of discovery (a Nexus host block's).
 * Undefined when no proxy stands for `host`, or the module already names a
 * proxy's host.
 */
export function proxyRoute(
  s: { host: string; namespace: string },
  proxies: readonly RegistryProxy[] = [],
): { proxy: RegistryProxy; host: string; namespace: string; modules?: string } | undefined {
  // A source written through a proxy already reads from its host; a Nexus label is resolved by its modules URL.
  const named = proxies.find((p) => sameHost(p.host, s.host));
  if (named) return named.modules ? { proxy: named, host: named.host, namespace: s.namespace, modules: named.modules } : undefined;
  const p = proxies.find((q) => sameHost(upstreamOf(q), s.host));
  if (!p) return undefined;
  return { proxy: p, host: p.host, namespace: p.repo ? `${p.repo}${ARTIFACTORY_JOINER}${s.namespace}` : s.namespace, ...(p.modules ? { modules: p.modules } : {}) };
}
