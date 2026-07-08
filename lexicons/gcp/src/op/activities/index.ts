/**
 * GCP Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `gcp` lexicon. Contributes the native GCP applier
 * (`gcpApply`), which maps CNRM resources to GCP REST calls since GCP has no
 * native deployment service to shell out to.
 */
export {
  gcpApply,
  applyResource,
  bucketInsertBody,
  pubSubTopicBody,
  storageBucketMapper,
  pubSubTopicMapper,
  MAPPERS,
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
  ApplyPlan,
  GcpHttp,
} from "./gcp-apply";
