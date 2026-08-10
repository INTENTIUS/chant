/**
 * Public data shapes for the chant Kubernetes API client (chant #1074).
 *
 * Everything here is plain data: no class, nothing imported from
 * `@kubernetes/client-node`, nothing imported from chant core. The lexicon
 * that consumes this package must be able to name these types without pulling
 * either dependency onto the build path.
 */

/** A live Kubernetes object, as the API server returned it. */
export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<Record<string, unknown>>;
    managedFields?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  status?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Addresses one object. `namespace` is ignored for cluster-scoped kinds. */
export interface ObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/**
 * How to find a resource in the cluster's discovery.
 *
 * - By GVK — what `describeResources` uses, because the generated operation
 *   surface gives it an exact `apiVersion` + `kind`.
 * - By kubectl-style resource string — what `waitForReady` uses, because its
 *   activity contract has always taken `kind` in the form `kubectl get`
 *   accepts (`certificates`, `raycluster.ray.io`, `Deployment`).
 */
export type ResourceSelector =
  | { apiVersion: string; kind: string }
  | { resource: string; group?: string };

/** One entry of an `APIResourceList`, as the cluster reports it. */
export interface ApiResourceInfo {
  /** Plural path segment, e.g. `deployments`. */
  name: string;
  singularName?: string;
  kind: string;
  namespaced: boolean;
  verbs: readonly string[];
  shortNames?: readonly string[];
  /** `""` for the core group. */
  group: string;
  version: string;
  /** `v1` or `apps/v1` — what goes in a manifest. */
  apiVersion: string;
}

/** Which credential path the client is authenticating with. */
export type CredentialPath =
  | "exec-plugin"
  | "auth-provider"
  | "token"
  | "client-certificate"
  | "basic-auth"
  | "in-cluster"
  | "none";

/**
 * Where an observation's credentials came from, recorded so the provenance of
 * a read is legible (chant #1074's managed-cluster note). A read authorized by
 * `aws eks get-token` and a read authorized by a static service-account token
 * are not equally trustworthy inputs to a drift report.
 */
export interface ClientProvenance {
  /** API server URL. */
  server: string;
  /** kubectl context the client resolved to. */
  context?: string;
  /** Where the context came from — a declared binding or the ambient default. */
  contextSource: "bound" | "ambient";
  credential: CredentialPath;
  /** The exec plugin's command, when `credential` is `exec-plugin`. */
  execCommand?: string;
  /** Where the kubeconfig itself came from. */
  kubeconfigSource: "explicit-string" | "explicit-path" | "default" | "in-cluster";
}

/**
 * One context of the merged kubeconfig, joined to the apiserver its cluster
 * resolves to (chant #1630). Plain data read out of a file: no credential is
 * touched, no exec plugin runs, no request is issued.
 */
export interface KubeconfigContextInfo {
  name: string;
  /** Cluster name the context names. Empty when the context declares none. */
  cluster: string;
  user?: string;
  namespace?: string;
  /** The apiserver URL the named cluster resolves to, when the config has one. */
  server?: string;
}

/** What {@link import("./client").readKubeconfigView} returns. */
export interface KubeconfigView {
  contexts: KubeconfigContextInfo[];
  currentContext?: string;
}

/** Options for {@link import("./client").createK8sClient}. */
export interface K8sClientOptions {
  /**
   * Literal kubeconfig YAML. Wins over every other source — which is how
   * tests avoid reading the developer's real `~/.kube/config`.
   */
  kubeconfig?: string;
  /** Path to a kubeconfig file. Wins over the ambient default. */
  kubeconfigPath?: string;
  /**
   * Context to use, from `k8s.profiles.<env>.context` (chant #1100/#1155).
   * Omitted means the kubeconfig's own current-context.
   */
  context?: string;
  /**
   * Exec credential-plugin commands this client may execute. Defaults to
   * {@link import("./credentials").DEFAULT_EXEC_ALLOWLIST}.
   */
  execAllowlist?: readonly string[];
  /**
   * Replaces `@kubernetes/client-node`'s HTTP send. This is the package's only
   * seam onto the network: URL construction, kubeconfig parsing, auth header
   * application and response handling all still run for real above it. Tests
   * pass one; production does not.
   */
  requestLayer?: RequestLayer;
  /** Max concurrent in-flight requests. Default 8. */
  concurrency?: number;
  /** Where the context came from, for provenance. Default `ambient`. */
  contextSource?: "bound" | "ambient";
  /**
   * How the context was selected, in words — e.g.
   * `bound by k8s.profiles.prod.context` or
   * `ambient; no k8s.profiles.local binding`. Stamped (with the resolved
   * context name) onto every API/transport failure the client throws, so a
   * `read-failed` reason names the cluster it read (chant #1488). Defaults to
   * the bare `contextSource`.
   */
  contextLabel?: string;
}

/**
 * `@kubernetes/client-node`'s promise-shaped HTTP library: it receives the
 * library's own `RequestContext` (fully built URL, method, headers including
 * whatever the auth path put there) and returns its own `ResponseContext`.
 *
 * Typed structurally rather than against the library's classes so this module
 * stays free of `@kubernetes/client-node` imports; `client.ts` checks the real
 * shapes where it matters.
 */
export interface RequestLayer {
  send(request: RequestContextLike): Promise<ResponseContextLike> | ResponseContextLike;
}

/** The subset of client-node's `RequestContext` this package and its tests read. */
export interface RequestContextLike {
  getUrl(): string;
  getHttpMethod(): string;
  getHeaders(): Record<string, string>;
  getBody(): unknown;
}

/** The subset of client-node's `ResponseContext` this package produces and consumes. */
export interface ResponseContextLike {
  httpStatusCode: number;
  headers: Record<string, string>;
  body: { text(): Promise<string> };
}
