/**
 * `awsCapabilityPlugin` — the aws lexicon's capability plugin. It contributes
 * every AWS operational leaf (apply, job-submission, host-delivery, safety, the
 * cloud-specific waits, and publish) through core's `CapabilityPlugin` contract
 * (`@intentius/chant/components/capability-plugin`), so a project declaring
 * `lexicons: ["aws"]` gets these verbs registered automatically when it runs
 * components — the seam docs/components/cloud-boundary describes. Core's starter
 * set carries only the agnostic verbs; the cloud leaves live here.
 */

import type { Capability } from "@intentius/chant/components/capability";
import type { CapabilityPlugin } from "@intentius/chant/components/capability-plugin";

import { publishImageCapability, loadImageOnHostCapability, publishArtifactCapability } from "./publish";
import { extractConfigBomCapability } from "./config-bom";
import {
  cfnDeployCapability,
  ecsUpdateServiceCapability,
  lambdaDeployCapability,
  s3SyncCapability,
  cdnInvalidateCapability,
  runMigrationCapability,
} from "./apply";
import { emrStartJobRunCapability, emrSubmitStepCapability } from "./job-submission";
import { codeDeployCapability, copyToHostCapability, remoteExecCapability } from "./host-delivery";
import { waitForStackCapability, waitSteadyStateCapability, waitJobCapability } from "./wait-aws";
import { snapshotBeforeCapability, rollbackPreviousCapability } from "./safety";

/** The AWS verb families this plugin contributes, grouped for `families()` — mirrors core's `STARTER_VERB_FAMILIES` shape. */
export const AWS_VERB_FAMILIES = {
  // `extract-config-bom` parses a synthesized CloudFormation template (#684).
  sbom: ["extract-config-bom"],
  publish: ["publish-image", "load-image-on-host", "publish-artifact"],
  apply: ["cfn-deploy", "ecs-update-service", "lambda-deploy", "s3-sync", "cdn-invalidate", "run-migration"],
  jobSubmission: ["emr-start-job-run", "emr-submit-step"],
  hostDelivery: ["code-deploy", "copy-to-host", "remote-exec"],
  waitVerify: ["wait-for-stack", "wait-steady-state", "wait-job"],
  safety: ["snapshot-before", "rollback-previous"],
} as const;

/** Every AWS-leaf capability, listed individually so each keeps its own `In`/`Out` generics (same reason core's starter plugin lists them one by one). */
function awsCapabilities(): Array<Capability<never, unknown>> {
  return [
    extractConfigBomCapability,
    publishImageCapability,
    loadImageOnHostCapability,
    publishArtifactCapability,
    cfnDeployCapability,
    ecsUpdateServiceCapability,
    lambdaDeployCapability,
    s3SyncCapability,
    cdnInvalidateCapability,
    runMigrationCapability,
    emrStartJobRunCapability,
    emrSubmitStepCapability,
    codeDeployCapability,
    copyToHostCapability,
    remoteExecCapability,
    waitForStackCapability,
    waitSteadyStateCapability,
    waitJobCapability,
    snapshotBeforeCapability,
    rollbackPreviousCapability,
  ] as unknown as Array<Capability<never, unknown>>;
}

/** The aws lexicon's capability plugin — loaded by core when a project's `chant.config.ts` lists `lexicons: ["aws"]`. */
export const awsCapabilityPlugin: CapabilityPlugin = {
  name: "aws",
  version: "1.0.0",
  capabilities: awsCapabilities,
  families: () => AWS_VERB_FAMILIES,
};
