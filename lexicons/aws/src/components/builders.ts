/**
 * Typed step-builders for the aws lexicon's verbs — the same ergonomic sugar
 * core offers for its agnostic verbs (#658), reusing the exported `step`
 * projection from `@intentius/chant/components`. `cfnDeploy({ template })` is
 * exactly `{ kind: "cfn-deploy", template }`, but with per-verb argument
 * checking from each capability's own `Input` type.
 */

import { step } from "@intentius/chant/components";
import type { ExtractConfigBomInput } from "./config-bom";
import type { PublishImageInput, PublishArtifactInput } from "./publish";
import type {
  CfnDeployInput,
  EcsUpdateServiceInput,
  LambdaDeployInput,
  S3SyncInput,
  CdnInvalidateInput,
  RunMigrationInput,
} from "./apply";
import type { EmrStartJobRunInput, EmrSubmitStepInput } from "./job-submission";
import type { CodeDeployInput, CopyToHostInput, RemoteExecInput } from "./host-delivery";
import type { WaitForStackInput, WaitSteadyStateInput, WaitJobInput } from "./wait-aws";
import type { SnapshotBeforeInput, RollbackPreviousInput } from "./safety";

// ── sbom ─────────────────────────────────────────────────────────────────────
export const extractConfigBom = step<ExtractConfigBomInput>("extract-config-bom");

// ── publish ──────────────────────────────────────────────────────────────────
export const publishImage = step<PublishImageInput>("publish-image");
export const loadImageOnHost = step<PublishImageInput>("load-image-on-host");
export const publishArtifact = step<PublishArtifactInput>("publish-artifact");
/** Alias for {@link publishArtifact} — the docs/epic use both names for the same verb. */
export const publishAsset = publishArtifact;

// ── apply ────────────────────────────────────────────────────────────────────
export const cfnDeploy = step<CfnDeployInput>("cfn-deploy");
export const ecsUpdateService = step<EcsUpdateServiceInput>("ecs-update-service");
export const lambdaDeploy = step<LambdaDeployInput>("lambda-deploy");
export const s3Sync = step<S3SyncInput>("s3-sync");
export const cdnInvalidate = step<CdnInvalidateInput>("cdn-invalidate");
export const runMigration = step<RunMigrationInput>("run-migration");

// ── job submission ───────────────────────────────────────────────────────────
export const emrStartJobRun = step<EmrStartJobRunInput>("emr-start-job-run");
export const emrSubmitStep = step<EmrSubmitStepInput>("emr-submit-step");

// ── host / code delivery ─────────────────────────────────────────────────────
export const codeDeploy = step<CodeDeployInput>("code-deploy");
export const copyToHost = step<CopyToHostInput>("copy-to-host");
export const remoteExec = step<RemoteExecInput>("remote-exec");

// ── wait / verify (cloud-specific) ───────────────────────────────────────────
export const waitForStack = step<WaitForStackInput>("wait-for-stack");
export const waitSteadyState = step<WaitSteadyStateInput>("wait-steady-state");
export const waitJob = step<WaitJobInput>("wait-job");

// ── safety / rollback ────────────────────────────────────────────────────────
export const snapshotBefore = step<SnapshotBeforeInput>("snapshot-before");
export const rollbackPrevious = step<RollbackPreviousInput>("rollback-previous");
