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
  storageBucketMapper,
  pubSubTopicMapper,
  pubSubSubscriptionMapper,
  cloudRunServiceMapper,
  MAPPERS,
  referencedNames,
  orderByReferences,
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
  ApplyPlan,
  GcpHttp,
} from "./gcp-apply";
