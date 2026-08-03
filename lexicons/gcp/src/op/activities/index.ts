/**
 * GCP Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `gcp` lexicon. Contributes the native GCP applier
 * (`gcpApply`), which maps CNRM resources to GCP REST calls since GCP has no
 * native deployment service to shell out to.
 */
export {
  gcpApply,
  gcpDelete,
  applyResource,
  deleteResource,
  waitForOperation,
  longRunningOperation,
  bucketInsertBody,
  pubSubTopicBody,
  pubSubSubscriptionBody,
  cloudRunServiceBody,
  secretBody,
  serviceAccountBody,
  storageBucketMapper,
  pubSubTopicMapper,
  pubSubSubscriptionMapper,
  cloudRunServiceMapper,
  secretManagerSecretMapper,
  gcpServiceAccountMapper,
  MAPPERS,
  referencedNames,
  orderByReferences,
  pruneOrphans,
  toApplyResult,
  type GcpNotAttempted,
  type GcpNotPrunable,
  chantOwnershipLabels,
  isChantOwned,
  resolveGcpProject,
  parseManifest,
} from "./gcp-apply";
export type {
  GcpApplyArgs,
  GcpResource,
  CnrmStorageBucket,
  BucketInsertBody,
  PubSubTopicBody,
  ResourceMapper,
  OperationSpec,
  ListSpec,
  ApplyPlan,
  GcpHttp,
} from "./gcp-apply";

// floci-gcp (GCP emulator) lifecycle — the typed twin of aws's flociUp/Down, so
// the trio's GCP op boots/tears down the emulator as a modeled step, not a shell.
export {
  flociGcpUp,
  flociGcpDown,
  flociGcpRunCommand,
  flociGcpRmCommand,
  flociGcpExistsCommand,
  flociGcpHealthUrl,
  flociGcpEndpoint,
} from "./floci-gcp";
export type { FlociGcpUpArgs, FlociGcpDownArgs } from "./floci-gcp";
