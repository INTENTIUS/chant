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
export type { K8sClient, ReadOptions, ApplyOptions, DeleteOptions, ListOptions, ReadLogOptions } from "./client";

export {
  K8sApiError,
  K8sTransportError,
  K8sClientUnavailableError,
  ExecCredentialNotAllowedError,
  FieldManagerError,
  KubeConfigError,
  UnknownResourceError,
} from "./errors";
export type { K8sStatus } from "./errors";

// chant's field-manager identity and the conflict surface — chant #1075.
export {
  CHANT_FIELD_MANAGER,
  FIELD_MANAGER_SEPARATOR,
  FIELD_MANAGER_MAX_LENGTH,
  fieldManagerFor,
  assertValidFieldManager,
  isChantFieldManager,
  chantStackOf,
} from "./field-manager";
export type { FieldManagerIdentity } from "./field-manager";

export {
  FieldManagerConflictError,
  asFieldManagerConflict,
  parseFieldConflicts,
  parseConflictMessage,
  renderConflictReport,
} from "./conflict";
export type { FieldConflict, ConflictReport } from "./conflict";

// managedFields primitives — the material chant #1076's deep observation reads.
export {
  managedFieldsOf,
  fieldSetsOf,
  managersOf,
  fieldsOwnedBy,
  chantOwnedFields,
  fieldOwners,
  fieldPathsOf,
  renderSegment,
} from "./managed-fields";
export type { ManagedFieldsEntry, ManagerFieldSet } from "./managed-fields";

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
