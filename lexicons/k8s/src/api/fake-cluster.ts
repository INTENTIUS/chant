/**
 * A fake cluster to point the k8s lexicon at, for tests (chant #1074).
 *
 * It builds a **real** `@intentius/chant-k8s-client` over a literal kubeconfig
 * with `@kubernetes/client-node`'s HTTP send replaced. So kubeconfig parsing,
 * context selection, the credential policy, API discovery, path construction
 * and the auth path all run for real; the only thing that does not happen is
 * the socket. Nothing reads `~/.kube/config` or `$KUBECONFIG`, and nothing can
 * reach a cluster the developer happens to have a context for.
 *
 * Shipped rather than kept in a test file because the lexicon's own tests, the
 * cross-lexicon lifecycle suite and a consumer wiring chant into their harness
 * all need the same thing.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import { apiResourceList, fakeKubeconfig, fakeRequestLayer, statusBody } from "@intentius/chant-k8s-client/testing";
import type { FakeRequestLayer, RecordedRequest } from "@intentius/chant-k8s-client/testing";
import { createK8sClient } from "@intentius/chant-k8s-client";
import type { ConnectedClient, ConnectOptions, K8sConnector } from "./connect";
import { operationTable } from "./operation-surface";

export interface FakeClusterOptions {
  /**
   * Objects the cluster holds, keyed by
   * `<apiVersion>/<Kind>/<namespace|_>/<name>`, e.g.
   * `apps/v1/Deployment/prod/web`. Build keys with {@link objectKey}.
   */
  objects?: Record<string, K8sObject>;
  /**
   * Entity types (or `<apiVersion> <Kind>` pairs) this cluster serves. Defaults
   * to every type in the generated operation surface, which is what makes a
   * CRD resolvable in a test without registering anything.
   */
  serves?: readonly string[];
  /** Full control: return a response for a request, or undefined to fall through. */
  respond?: (request: RecordedRequest) => { status?: number; body?: unknown } | undefined;
  /** Kubeconfig to hand the client. Defaults to a single-context one. */
  kubeconfig?: string;
}

export interface FakeCluster {
  connector: K8sConnector;
  layer: FakeRequestLayer;
  /** Connect options every call received, for asserting the binding path. */
  connects: ConnectOptions[];
}

/** Key an object the way {@link fakeCluster} indexes them. */
export function objectKey(apiVersion: string, kind: string, name: string, namespace?: string): string {
  return `${apiVersion}/${kind}/${namespace ?? "_"}/${name}`;
}

/** Build a live object with chant's ownership marker already on it. */
export function ownedObject(
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | undefined,
  extra: Partial<K8sObject> = {},
): K8sObject {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      uid: `uid-${name}`,
      resourceVersion: "1",
      labels: { "app.kubernetes.io/managed-by": "chant" },
      ...(extra.metadata ?? {}),
    },
    ...(extra.status ? { status: extra.status } : {}),
  };
}

interface ServedResource {
  apiVersion: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

function servedResources(serves: readonly string[] | undefined): ServedResource[] {
  const table = operationTable();
  const entries = serves
    ? serves.map((s) => table[s]).filter((d) => d !== undefined)
    : Object.values(table);
  return entries
    .filter((d) => d.verbs.length > 0)
    .map((d) => ({
      apiVersion: d.apiVersion,
      kind: d.kind,
      plural: d.plural,
      namespaced: d.scope === "Namespaced",
    }));
}

/**
 * A cluster that answers discovery for the kinds it serves and holds the
 * objects it was given. Anything else 404s with a real `Status` body, which is
 * how a test drives the absent branch of the observation tri-state.
 */
export function fakeCluster(options: FakeClusterOptions = {}): FakeCluster {
  const resources = servedResources(options.serves);
  const byApiVersion = new Map<string, ServedResource[]>();
  for (const r of resources) {
    const list = byApiVersion.get(r.apiVersion) ?? [];
    list.push(r);
    byApiVersion.set(r.apiVersion, list);
  }

  // Path → the object it addresses, and list path → its members, precomputed
  // so the responder below is a pair of lookups.
  const byPath = new Map<string, K8sObject>();
  const listPaths = new Map<string, K8sObject[]>();
  const addToList = (path: string, object: K8sObject): void => {
    const list = listPaths.get(path) ?? [];
    list.push(object);
    listPaths.set(path, list);
  };
  for (const [key, object] of Object.entries(options.objects ?? {})) {
    const [group, version, kind, namespace, name] = splitKey(key);
    const apiVersion = group ? `${group}/${version}` : version;
    const resource = resources.find((r) => r.apiVersion === apiVersion && r.kind === kind);
    if (!resource) continue;
    const base = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
    if (resource.namespaced) {
      const ns = namespace === "_" ? "default" : namespace;
      byPath.set(`${base}/namespaces/${ns}/${resource.plural}/${name}`, object);
      addToList(`${base}/namespaces/${ns}/${resource.plural}`, object);
    } else {
      byPath.set(`${base}/${resource.plural}/${name}`, object);
    }
    // Cluster-wide list, which is what `chant import` sweeps.
    addToList(`${base}/${resource.plural}`, object);
  }

  const groups = new Map<string, string>();
  for (const apiVersion of byApiVersion.keys()) {
    if (!apiVersion.includes("/")) continue;
    const group = apiVersion.slice(0, apiVersion.indexOf("/"));
    if (!groups.has(group)) groups.set(group, apiVersion);
  }

  const layer = fakeRequestLayer((request) => {
    const custom = options.respond?.(request);
    if (custom !== undefined) return custom;

    if (request.path === "/api") return { body: { kind: "APIVersions", versions: ["v1"] } };
    if (request.path === "/apis") {
      return {
        body: {
          kind: "APIGroupList",
          groups: [...groups].map(([name, apiVersion]) => ({
            name,
            preferredVersion: { groupVersion: apiVersion, version: apiVersion.split("/")[1] },
            versions: [{ groupVersion: apiVersion }],
          })),
        },
      };
    }

    const apiVersion = apiVersionFromDiscoveryPath(request.path);
    if (apiVersion) {
      const served = byApiVersion.get(apiVersion);
      if (!served) return { status: 404, body: statusBody(404, "NotFound", "the server could not find the requested resource") };
      return {
        body: apiResourceList(
          apiVersion,
          served.map((r) => ({ name: r.plural, kind: r.kind, namespaced: r.namespaced })),
        ),
      };
    }

    const object = byPath.get(request.path);
    if (object) return { body: object };

    if (isListPath(request.path, resources)) {
      return { body: { kind: "List", items: listPaths.get(request.path) ?? [], metadata: {} } };
    }

    return { status: 404, body: statusBody(404, "NotFound", `${request.path} not found`) };
  });

  const connects: ConnectOptions[] = [];
  const connector: K8sConnector = async (connectOptions): Promise<ConnectedClient> => {
    connects.push(connectOptions);
    const client = await createK8sClient({
      kubeconfig: options.kubeconfig ?? fakeKubeconfig(),
      requestLayer: layer,
      ...(connectOptions.context ? { context: connectOptions.context } : {}),
      ...connectOptions.client,
    });
    return { client, target: { source: "ambient" } };
  };

  return { connector, layer, connects };
}

function splitKey(key: string): [group: string, version: string, kind: string, namespace: string, name: string] {
  const parts = key.split("/");
  // `apps/v1/Deployment/prod/web` (5) or `v1/Service/prod/web` (4)
  if (parts.length === 5) return [parts[0], parts[1], parts[2], parts[3], parts[4]];
  return ["", parts[0], parts[1], parts[2], parts[3]];
}

function apiVersionFromDiscoveryPath(path: string): string | undefined {
  if (/^\/api\/[^/]+$/.test(path)) return path.slice("/api/".length);
  if (/^\/apis\/[^/]+\/[^/]+$/.test(path)) return path.slice("/apis/".length);
  return undefined;
}

/** True when the path addresses a collection of a kind this cluster serves. */
function isListPath(path: string, resources: ServedResource[]): boolean {
  const plural = path.split("/").pop();
  return resources.some((r) => r.plural === plural);
}
