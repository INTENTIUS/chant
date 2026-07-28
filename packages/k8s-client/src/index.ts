/**
 * `@intentius/chant-k8s-client` — the typed Kubernetes API client behind the
 * k8s lexicon's read and write paths (chant #1074, epic #1073).
 *
 * It is a package rather than a directory inside the lexicon for one reason:
 * this is the first chant code that holds live cluster credentials, and the
 * synthesis-purity boundary around it should be structural rather than a lint
 * rule. `chant build` cannot resolve this package, because nothing on the
 * build path imports it — the lexicon reaches it through a dynamic import from
 * modules that are themselves only loaded by the observation and Op paths, and
 * `examples/k8s-client-boundary.test.ts` walks the static import graph to prove
 * it stays that way.
 */

export {
  createK8sClient,
  readAmbientContext,
  loadClientNode,
  isK8sClientAvailable,
  apiVersionPath,
  splitApiVersion,
  selectorText,
  refText,
} from "./client";
export type { K8sClient, ReadOptions, ApplyOptions } from "./client";

export {
  K8sApiError,
  K8sTransportError,
  K8sClientUnavailableError,
  ExecCredentialNotAllowedError,
  KubeConfigError,
  UnknownResourceError,
} from "./errors";
export type { K8sStatus } from "./errors";

export {
  DEFAULT_EXEC_ALLOWLIST,
  assertExecCredentialAllowed,
  credentialPathOf,
  execConfigOf,
  execCommandName,
} from "./credentials";
export type { ExecConfig, KubeConfigUser } from "./credentials";

export { mapConcurrent, DEFAULT_CONCURRENCY } from "./concurrency";

export type {
  ApiResourceInfo,
  ClientProvenance,
  CredentialPath,
  K8sClientOptions,
  K8sObject,
  ObjectRef,
  RequestContextLike,
  RequestLayer,
  ResourceSelector,
  ResponseContextLike,
} from "./types";
