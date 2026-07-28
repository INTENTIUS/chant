/**
 * The chant Kubernetes API client — chant #1074.
 *
 * ## What is rented and what is chant's
 *
 * `@kubernetes/client-node` supplies transport and authentication: kubeconfig
 * parsing and merging, client certificates, bearer tokens, exec credential
 * plugins with expiry-aware caching, in-cluster service-account credentials,
 * TLS (CA bundles, `insecure-skip-tls-verify`, `tls-server-name`), HTTP and
 * SOCKS proxies, and impersonation. That work is done, maintained, and
 * security-sensitive; reimplementing it buys nothing.
 *
 * Chant supplies the rest: resource resolution through the cluster's own
 * discovery (rather than a table someone has to keep extending), bounded
 * concurrency, typed failures, an exec-plugin allowlist, and credential
 * provenance.
 *
 * ## Raw objects, not deserialized models
 *
 * The library also ships `KubernetesObjectApi`, which does path construction
 * and discovery. It is not used, for one reason: it runs every response
 * through `ObjectSerializer`, which coerces known kinds into generated model
 * classes — dropping fields the model does not declare and turning timestamps
 * into `Date`s — while passing CRDs through raw. An observation path must not
 * behave differently for a Deployment and a RayCluster, and `managedFields`
 * (the epic's whole point, chant #1076) is exactly the sort of field a model
 * coercion loses. So requests are issued against the library's `RequestContext`
 * and the JSON is used as it arrived.
 *
 * ## The one seam
 *
 * `requestLayer` replaces the library's HTTP send and nothing else. Everything
 * above it — kubeconfig parsing, context selection, URL construction, the auth
 * path that writes the `Authorization` header — runs for real, which is what
 * makes a test that injects one worth writing.
 */

import type * as k8s from "@kubernetes/client-node";
import {
  K8sApiError,
  K8sClientUnavailableError,
  K8sTransportError,
  KubeConfigError,
  UnknownResourceError,
} from "./errors";
import { assertExecCredentialAllowed, credentialPathOf, DEFAULT_EXEC_ALLOWLIST } from "./credentials";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "./concurrency";
import type {
  ApiResourceInfo,
  ClientProvenance,
  K8sClientOptions,
  K8sObject,
  ObjectRef,
  RequestContextLike,
  ResourceSelector,
  ResponseContextLike,
} from "./types";

type ClientNode = typeof import("@kubernetes/client-node");

let clientNodeModule: Promise<ClientNode> | undefined;

/**
 * Load `@kubernetes/client-node`, once per process.
 *
 * Deliberately a function, not a module-level `await import`: this package is
 * an optional dependency reached only from chant's read/write paths, and
 * resolving it at module load would defeat that. Nothing here touches the
 * filesystem at module init either (chant #1081).
 */
export async function loadClientNode(): Promise<ClientNode> {
  if (!clientNodeModule) {
    clientNodeModule = import("@kubernetes/client-node").catch((err: unknown) => {
      clientNodeModule = undefined;
      throw new K8sClientUnavailableError(err);
    });
  }
  return clientNodeModule;
}

/** True when `@kubernetes/client-node` can be loaded in this install. */
export async function isK8sClientAvailable(): Promise<boolean> {
  try {
    await loadClientNode();
    return true;
  } catch {
    return false;
  }
}

/**
 * The kubeconfig's own current-context, without building a client.
 *
 * This is what the environment→cluster binding compares against (chant #1100):
 * "the ambient context" is a property of the kubeconfig, and reading it should
 * not require the kubeconfig to also resolve to a usable cluster — a binding
 * pointing at a valid context has to survive a broken current-context, which is
 * exactly the situation the binding exists to fix. Returns undefined when no
 * kubeconfig can be read at all.
 */
export async function readAmbientContext(
  options: Pick<K8sClientOptions, "kubeconfig" | "kubeconfigPath"> = {},
): Promise<string | undefined> {
  const mod = await loadClientNode();
  const kc = new mod.KubeConfig();
  try {
    if (options.kubeconfig !== undefined) kc.loadFromString(options.kubeconfig);
    else if (options.kubeconfigPath !== undefined) kc.loadFromFile(options.kubeconfigPath);
    else kc.loadFromDefault();
  } catch {
    return undefined;
  }
  return kc.getCurrentContext() || undefined;
}

/** Options for a single object read. */
export interface ReadOptions {
  signal?: AbortSignal;
}

/** Options for {@link K8sClient.apply}. */
export interface ApplyOptions {
  /** Field manager recorded on the objects this apply owns. Default `chant`. */
  fieldManager?: string;
  /**
   * Take ownership of fields another manager owns instead of failing with a
   * 409. Default false — chant #1075 is where the conflict surface proper
   * lives; here a conflict simply arrives as a typed {@link K8sApiError}.
   */
  force?: boolean;
  /** Server-side dry run — validates and returns the result, persists nothing. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** The client surface the k8s lexicon consumes. */
export interface K8sClient {
  /** Where this client is pointed and what authorized it. */
  readonly provenance: ClientProvenance;
  /** Namespace the resolved context defaults to. */
  readonly defaultNamespace: string;
  /**
   * Resolve a selector against the cluster's API discovery. Returns undefined
   * when discovery answered and reported no such resource — which means no
   * instance of it can exist.
   */
  resolve(selector: ResourceSelector, signal?: AbortSignal): Promise<ApiResourceInfo | undefined>;
  /** GET one object. Throws {@link K8sApiError} with `notFound` when absent. */
  read(ref: ObjectRef, options?: ReadOptions): Promise<K8sObject>;
  /** GET one object, returning undefined instead of throwing on a 404. */
  readIfPresent(ref: ObjectRef, options?: ReadOptions): Promise<K8sObject | undefined>;
  /** LIST a kind, optionally namespaced. Follows `continue` tokens. */
  list(selector: ResourceSelector, options?: { namespace?: string; signal?: AbortSignal }): Promise<K8sObject[]>;
  /** Server-side apply one object. Creates it when absent. */
  apply(object: K8sObject, options?: ApplyOptions): Promise<K8sObject>;
  /** Run `fn` over `items` with this client's concurrency ceiling. */
  concurrently<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
  /** The API resource lists discovery has been asked for so far, for tests and diagnostics. */
  discoveryCacheKeys(): string[];
}

interface ApiResourceListResponse {
  groupVersion?: string;
  resources?: Array<{
    name?: string;
    singularName?: string;
    namespaced?: boolean;
    kind?: string;
    verbs?: string[];
    shortNames?: string[];
  }>;
}

/**
 * Build a client. Nothing is read from the network here — the kubeconfig is
 * parsed, the context resolved, and the credential policy enforced, all before
 * the first request, so a refusal happens before any exec plugin runs.
 */
export async function createK8sClient(options: K8sClientOptions = {}): Promise<K8sClient> {
  const mod = await loadClientNode();

  const kc = new mod.KubeConfig();
  let kubeconfigSource: ClientProvenance["kubeconfigSource"];
  if (options.kubeconfig !== undefined) {
    kc.loadFromString(options.kubeconfig);
    kubeconfigSource = "explicit-string";
  } else if (options.kubeconfigPath !== undefined) {
    kc.loadFromFile(options.kubeconfigPath);
    kubeconfigSource = "explicit-path";
  } else {
    kc.loadFromDefault();
    kubeconfigSource = kc.getCurrentContext() === "inCluster" ? "in-cluster" : "default";
  }

  if (options.context !== undefined) {
    if (!kc.getContextObject(options.context)) {
      const known = kc.getContexts().map((c) => c.name);
      throw new KubeConfigError(
        `the kubeconfig has no context named "${options.context}" ` +
          `(it has ${known.length > 0 ? known.map((n) => `"${n}"`).join(", ") : "no contexts at all"}). ` +
          `This is the context the environment is bound to via k8s.profiles.<env>.context.`,
      );
    }
    kc.setCurrentContext(options.context);
  }

  const cluster = kc.getCurrentCluster();
  if (!cluster) {
    throw new KubeConfigError(
      `the kubeconfig resolves to no cluster for context "${kc.getCurrentContext() || "(unset)"}"`,
    );
  }

  const user = kc.getCurrentUser();
  // Before anything is sent, and therefore before any credential plugin runs.
  assertExecCredentialAllowed(user, options.execAllowlist ?? DEFAULT_EXEC_ALLOWLIST);

  const provenance: ClientProvenance = {
    server: cluster.server,
    context: kc.getCurrentContext() || undefined,
    contextSource: options.contextSource ?? "ambient",
    kubeconfigSource,
    ...credentialPathOf(user),
  };

  const configuration = mod.createConfiguration({
    baseServer: new mod.ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
    ...(options.requestLayer
      ? {
          httpApi: mod.wrapHttpLibrary({
            send: (request: k8s.RequestContext) =>
              Promise.resolve(
                options.requestLayer!.send(request as unknown as RequestContextLike),
              ) as Promise<k8s.ResponseContext>,
          }),
        }
      : {}),
  });

  const defaultNamespace = kc.getContextObject(kc.getCurrentContext())?.namespace || "default";
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  // apiVersion → its APIResourceList, or null when the cluster does not serve
  // that group/version at all. Promises are cached, not values, so N entities
  // resolved concurrently issue one discovery request between them rather
  // than N identical ones.
  const discoveryCache = new Map<string, Promise<ApiResourceListResponse | null>>();
  let groupVersionsCache: Promise<string[]> | undefined;

  async function send(
    path: string,
    method: "GET" | "PATCH" | "POST" | "PUT" | "DELETE",
    opts: {
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      signal?: AbortSignal;
      target?: string;
    } = {},
  ): Promise<{ status: number; body: string }> {
    const ctx = configuration.baseServer.makeRequestContext(path, method as k8s.HttpMethod);
    ctx.setHeaderParam("Accept", "application/json");
    for (const [key, value] of Object.entries(opts.query ?? {})) ctx.setQueryParam(key, value);
    if (opts.body !== undefined) {
      ctx.setHeaderParam("Content-Type", opts.contentType ?? "application/json");
      ctx.setBody(opts.body);
    }
    if (opts.signal) ctx.setSignal(opts.signal);

    // Auth runs per request: an exec plugin's token can expire mid-observation,
    // and client-node re-invokes it only when it has to.
    await kc.applySecurityAuthentication(ctx);

    let response: ResponseContextLike;
    try {
      response = (await configuration.httpApi
        .send(ctx)
        .toPromise()) as unknown as ResponseContextLike;
    } catch (err) {
      throw new K8sTransportError(
        err instanceof Error ? err.message : String(err),
        opts.target ?? `${method} ${path}`,
        { cause: err },
      );
    }

    let text: string;
    try {
      text = await response.body.text();
    } catch (err) {
      throw new K8sTransportError(
        `response body could not be read: ${err instanceof Error ? err.message : String(err)}`,
        opts.target ?? `${method} ${path}`,
        { cause: err },
      );
    }
    return { status: response.httpStatusCode, body: text };
  }

  async function sendJson<T>(
    path: string,
    method: "GET" | "PATCH" | "POST" | "PUT" | "DELETE",
    opts: Parameters<typeof send>[2] = {},
  ): Promise<T> {
    const { status, body } = await send(path, method, opts);
    if (status < 200 || status > 299) {
      throw K8sApiError.fromResponse(status, body, opts.target);
    }
    try {
      return JSON.parse(body) as T;
    } catch (err) {
      throw new K8sTransportError(
        `the API server returned HTTP ${status} with a body that is not JSON`,
        opts.target ?? `${method} ${path}`,
        { cause: err },
      );
    }
  }

  async function apiResourceList(apiVersion: string, signal?: AbortSignal): Promise<ApiResourceListResponse | null> {
    const cached = discoveryCache.get(apiVersion);
    if (cached) return cached;
    const pending = (async () => {
      try {
        return await sendJson<ApiResourceListResponse>(apiVersionPath(apiVersion), "GET", {
          signal,
          target: `discovery ${apiVersion}`,
        });
      } catch (err) {
        // A 404 on the discovery document means the cluster serves no such
        // group/version. That is an answer, not a failure — cache it.
        if (err instanceof K8sApiError && err.notFound) return null;
        discoveryCache.delete(apiVersion);
        throw err;
      }
    })();
    discoveryCache.set(apiVersion, pending);
    return pending;
  }

  async function servedGroupVersions(signal?: AbortSignal): Promise<string[]> {
    if (groupVersionsCache) return groupVersionsCache;
    groupVersionsCache = (async () => {
      const out: string[] = [];
      const core = await sendJson<{ versions?: string[] }>("/api", "GET", {
        signal,
        target: "discovery /api",
      });
      out.push(...(core.versions ?? ["v1"]));
      const groups = await sendJson<{
        groups?: Array<{
          name?: string;
          preferredVersion?: { groupVersion?: string };
          versions?: Array<{ groupVersion?: string }>;
        }>;
      }>("/apis", "GET", { signal, target: "discovery /apis" });
      for (const group of groups.groups ?? []) {
        const preferred = group.preferredVersion?.groupVersion;
        if (preferred) out.push(preferred);
        for (const v of group.versions ?? []) {
          if (v.groupVersion && v.groupVersion !== preferred) out.push(v.groupVersion);
        }
      }
      return [...new Set(out)];
    })().catch((err: unknown) => {
      groupVersionsCache = undefined;
      throw err;
    });
    return groupVersionsCache;
  }

  function toInfo(apiVersion: string, entry: NonNullable<ApiResourceListResponse["resources"]>[number]): ApiResourceInfo {
    const [group, version] = splitApiVersion(apiVersion);
    return {
      name: entry.name ?? "",
      singularName: entry.singularName || undefined,
      kind: entry.kind ?? "",
      namespaced: entry.namespaced === true,
      verbs: entry.verbs ?? [],
      shortNames: entry.shortNames,
      group,
      version,
      apiVersion,
    };
  }

  async function resolveByGvk(
    apiVersion: string,
    kind: string,
    signal?: AbortSignal,
  ): Promise<ApiResourceInfo | undefined> {
    const list = await apiResourceList(apiVersion, signal);
    if (!list) return undefined;
    const entry = (list.resources ?? []).find((r) => r.kind === kind && !(r.name ?? "").includes("/"));
    return entry ? toInfo(apiVersion, entry) : undefined;
  }

  async function resolveByResourceString(
    resource: string,
    group: string | undefined,
    signal?: AbortSignal,
  ): Promise<ApiResourceInfo | undefined> {
    // `kubectl get raycluster.ray.io` — everything after the first dot is the
    // API group, which is how kubectl itself disambiguates.
    const dot = resource.indexOf(".");
    const bare = dot === -1 ? resource : resource.slice(0, dot);
    const fromString = dot === -1 ? undefined : resource.slice(dot + 1);
    const wantedGroup = fromString ?? group;
    const needle = bare.toLowerCase();

    const all = await servedGroupVersions(signal);
    const candidates =
      wantedGroup === undefined
        ? all
        : all.filter((gv) => splitApiVersion(gv)[0] === (wantedGroup === "" ? "" : wantedGroup));

    const lists = await mapConcurrent(
      candidates,
      async (gv) => ({ gv, list: await apiResourceList(gv, signal).catch(() => null) }),
      concurrency,
    );

    // Plural first, then singular, then kind, then short names — kubectl's own
    // precedence, so `kubectl get certificate` and this agree.
    const matchers: Array<(r: NonNullable<ApiResourceListResponse["resources"]>[number]) => boolean> = [
      (r) => (r.name ?? "").toLowerCase() === needle,
      (r) => (r.singularName ?? "").toLowerCase() === needle,
      (r) => (r.kind ?? "").toLowerCase() === needle,
      (r) => (r.shortNames ?? []).some((s) => s.toLowerCase() === needle),
    ];
    for (const matches of matchers) {
      for (const { gv, list } of lists) {
        const entry = (list?.resources ?? []).find((r) => !(r.name ?? "").includes("/") && matches(r));
        if (entry) return toInfo(gv, entry);
      }
    }
    return undefined;
  }

  async function resolve(selector: ResourceSelector, signal?: AbortSignal): Promise<ApiResourceInfo | undefined> {
    return "apiVersion" in selector
      ? resolveByGvk(selector.apiVersion, selector.kind, signal)
      : resolveByResourceString(selector.resource, selector.group, signal);
  }

  async function resolveOrThrow(selector: ResourceSelector, signal?: AbortSignal): Promise<ApiResourceInfo> {
    const info = await resolve(selector, signal);
    if (!info) throw new UnknownResourceError(selectorText(selector));
    return info;
  }

  function objectPath(info: ApiResourceInfo, name: string | undefined, namespace: string | undefined): string {
    const parts = [apiVersionPath(info.apiVersion)];
    if (info.namespaced) parts.push("namespaces", encodeURIComponent(namespace || defaultNamespace));
    parts.push(info.name);
    if (name) parts.push(encodeURIComponent(name));
    return parts.join("/");
  }

  async function read(ref: ObjectRef, opts: ReadOptions = {}): Promise<K8sObject> {
    const info = await resolveOrThrow({ apiVersion: ref.apiVersion, kind: ref.kind }, opts.signal);
    return sendJson<K8sObject>(objectPath(info, ref.name, ref.namespace), "GET", {
      signal: opts.signal,
      target: refText(ref),
    });
  }

  async function readIfPresent(ref: ObjectRef, opts: ReadOptions = {}): Promise<K8sObject | undefined> {
    try {
      return await read(ref, opts);
    } catch (err) {
      if (err instanceof K8sApiError && err.notFound) return undefined;
      throw err;
    }
  }

  async function list(
    selector: ResourceSelector,
    opts: { namespace?: string; signal?: AbortSignal } = {},
  ): Promise<K8sObject[]> {
    const info = await resolveOrThrow(selector, opts.signal);
    const items: K8sObject[] = [];
    let cont: string | undefined;
    do {
      const page = await sendJson<{ items?: K8sObject[]; metadata?: { continue?: string } }>(
        // Omitting the namespace segment lists across all namespaces, which is
        // what `kubectl get <kind> -A` does and what the import path wants.
        opts.namespace
          ? objectPath(info, undefined, opts.namespace)
          : `${apiVersionPath(info.apiVersion)}/${info.name}`,
        "GET",
        {
          signal: opts.signal,
          query: cont ? { continue: cont } : undefined,
          target: `list ${selectorText(selector)}`,
        },
      );
      items.push(...(page.items ?? []));
      cont = page.metadata?.continue || undefined;
    } while (cont);
    return items;
  }

  async function apply(object: K8sObject, opts: ApplyOptions = {}): Promise<K8sObject> {
    const apiVersion = object.apiVersion;
    const kind = object.kind;
    if (!apiVersion || !kind) {
      throw new KubeConfigError(
        `cannot apply an object without both apiVersion and kind (got apiVersion=${String(apiVersion)}, kind=${String(kind)})`,
      );
    }
    const name = object.metadata?.name;
    if (!name) {
      throw new KubeConfigError(`cannot apply a ${apiVersion} ${kind} without metadata.name`);
    }
    const info = await resolveOrThrow({ apiVersion, kind }, opts.signal);
    const query: Record<string, string> = {
      fieldManager: opts.fieldManager ?? "chant",
      force: String(opts.force ?? false),
    };
    if (opts.dryRun) query.dryRun = "All";
    return sendJson<K8sObject>(objectPath(info, name, object.metadata?.namespace), "PATCH", {
      // Server-side apply. JSON is valid YAML, so the JSON body is accepted
      // under the apply-patch content type without a YAML round trip.
      contentType: "application/apply-patch+yaml",
      body: JSON.stringify(object),
      query,
      signal: opts.signal,
      target: refText({ apiVersion, kind, name, namespace: object.metadata?.namespace }),
    });
  }

  return {
    provenance,
    defaultNamespace,
    resolve,
    read,
    readIfPresent,
    list,
    apply,
    concurrently: (items, fn) => mapConcurrent(items, fn, concurrency),
    discoveryCacheKeys: () => [...discoveryCache.keys()].sort(),
  };
}

/** `v1` → `/api/v1`; `apps/v1` → `/apis/apps/v1`. */
export function apiVersionPath(apiVersion: string): string {
  return apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
}

/** `apps/v1` → `["apps", "v1"]`; `v1` → `["", "v1"]`. */
export function splitApiVersion(apiVersion: string): [group: string, version: string] {
  const slash = apiVersion.indexOf("/");
  return slash === -1 ? ["", apiVersion] : [apiVersion.slice(0, slash), apiVersion.slice(slash + 1)];
}

/** Human phrasing of a selector, for error messages. */
export function selectorText(selector: ResourceSelector): string {
  return "apiVersion" in selector
    ? `${selector.apiVersion} ${selector.kind}`
    : selector.group
      ? `${selector.resource}.${selector.group}`
      : selector.resource;
}

/** Human phrasing of an object reference, for error messages. */
export function refText(ref: ObjectRef): string {
  return `${ref.apiVersion} ${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
}
