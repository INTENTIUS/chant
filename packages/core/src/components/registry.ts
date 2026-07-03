/**
 * The starter capability registry — one `CapabilityRegistry` pre-seeded with
 * every verb in the starter set (epic #551, issue #554). All stubs; no cloud
 * calls. A later phase (#559, capability plugin contract) adds discovery of
 * third-party/cloud-implemented capabilities the same way lexicons are
 * discovered today.
 */

import { CapabilityRegistry } from "./capability";
import {
  dockerBuild,
  zipPackage,
  jvmBuild,
  publishImage,
  loadImageOnHost,
  publishArtifact,
  cfnDeploy,
  ecsUpdateService,
  lambdaDeploy,
  s3Sync,
  cdnInvalidate,
  runMigration,
  emrStartJobRun,
  emrSubmitStep,
  codeDeploy,
  copyToHost,
  remoteExec,
  waitForStack,
  waitSteadyState,
  waitClusterHealthy,
  waitEndpoint,
  waitJob,
  healthGate,
  snapshotBefore,
  rollbackPrevious,
  shell,
} from "./verbs/index";

/** Build a fresh `CapabilityRegistry` containing every starter-set verb stub. */
export function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  // Registered individually (not looped over an array) so each call's In/Out
  // generics are inferred from that capability's own type — a shared array
  // literal would widen every entry to a lossy common supertype.
  registry.register(dockerBuild);
  registry.register(zipPackage);
  registry.register(jvmBuild);
  registry.register(publishImage);
  registry.register(loadImageOnHost);
  registry.register(publishArtifact);
  registry.register(cfnDeploy);
  registry.register(ecsUpdateService);
  registry.register(lambdaDeploy);
  registry.register(s3Sync);
  registry.register(cdnInvalidate);
  registry.register(runMigration);
  registry.register(emrStartJobRun);
  registry.register(emrSubmitStep);
  registry.register(codeDeploy);
  registry.register(copyToHost);
  registry.register(remoteExec);
  registry.register(waitForStack);
  registry.register(waitSteadyState);
  registry.register(waitClusterHealthy);
  registry.register(waitEndpoint);
  registry.register(waitJob);
  registry.register(healthGate);
  registry.register(snapshotBefore);
  registry.register(rollbackPrevious);
  registry.register(shell);
  return registry;
}

/** Every `kind` in the starter verb set, grouped by family — useful for tests and docs generation. */
export const STARTER_VERB_FAMILIES = {
  build: ["docker-build", "zip-package", "jvm-build"],
  publish: ["publish-image", "load-image-on-host", "publish-artifact"],
  apply: ["cfn-deploy", "ecs-update-service", "lambda-deploy", "s3-sync", "cdn-invalidate", "run-migration"],
  jobSubmission: ["emr-start-job-run", "emr-submit-step"],
  hostDelivery: ["code-deploy", "copy-to-host", "remote-exec"],
  waitVerify: [
    "wait-for-stack",
    "wait-steady-state",
    "wait-cluster-healthy",
    "wait-endpoint",
    "wait-job",
    "health-gate",
  ],
  safety: ["snapshot-before", "rollback-previous"],
  escapeHatch: ["shell"],
} as const;
