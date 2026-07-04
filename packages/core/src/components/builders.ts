/**
 * Typed step-builder API (#658) — ergonomic sugar over the kind-literal
 * `Step`/`BuildSpec` contract. `phase("Publish", [publishImage({ from, to })])`
 * is exactly `phase("Publish", [{ kind: "publish-image", from, to }])`, but
 * with per-verb argument checking and autocomplete from each capability's own
 * `Input` type.
 *
 * These are pure projections: a builder returns the same kind-literal the
 * driver dispatches on (see ./component.ts's `Step`), so the JSON contract
 * (component.schema.json) stays authoritative and a hand-written or
 * non-chant-authored component keeps working. The runtime `Capability`
 * objects live under `*Capability` names (./verbs/*), registered by `.kind`.
 */

import type { BuildSpec, Step } from "./component";
import type {
  DockerBuildInput,
  ZipPackageInput,
  JvmBuildInput,
  GenerateSbomInput,
  ExtractConfigBomInput,
  PublishImageInput,
  PublishArtifactInput,
  SignInput,
  AttestProvenanceInput,
  VerifyInput,
  ScanVulnerabilitiesInput,
  VulnGateInput,
  CfnDeployInput,
  EcsUpdateServiceInput,
  LambdaDeployInput,
  S3SyncInput,
  CdnInvalidateInput,
  RunMigrationInput,
  EmrStartJobRunInput,
  EmrSubmitStepInput,
  CodeDeployInput,
  CopyToHostInput,
  RemoteExecInput,
  WaitForStackInput,
  WaitSteadyStateInput,
  WaitClusterHealthyInput,
  WaitEndpointInput,
  WaitJobInput,
  HealthGateInput,
  SnapshotBeforeInput,
  RollbackPreviousInput,
  ShellInput,
} from "./verbs/index";

/** Build a `(input) => Step` for one deploy verb: tags the input with its `kind`. */
function step<In extends object>(kind: string): (input: In) => Step {
  return (input) => ({ kind, ...input }) as Step;
}

/** Build a `(input) => BuildSpec` for one build verb (the `build` field, not `deploy`). */
function buildSpec<In extends object>(kind: string): (input: In) => BuildSpec {
  return (input) => ({ kind, ...input }) as BuildSpec;
}

// ── build family → BuildSpec (the component's `build` field) ─────────────────
export const dockerBuild = buildSpec<DockerBuildInput>("docker-build");
export const zipPackage = buildSpec<ZipPackageInput>("zip-package");
export const jvmBuild = buildSpec<JvmBuildInput>("jvm-build");

// ── sbom ─────────────────────────────────────────────────────────────────────
export const generateSbom = step<GenerateSbomInput>("generate-sbom");
export const extractConfigBom = step<ExtractConfigBomInput>("extract-config-bom");

// ── publish ──────────────────────────────────────────────────────────────────
export const publishImage = step<PublishImageInput>("publish-image");
export const loadImageOnHost = step<PublishImageInput>("load-image-on-host");
export const publishArtifact = step<PublishArtifactInput>("publish-artifact");
/** Alias for {@link publishArtifact} — the docs/epic use both names for the same verb. */
export const publishAsset = publishArtifact;

// ── supply-chain security / policy ───────────────────────────────────────────
export const sign = step<SignInput>("sign");
export const attestProvenance = step<AttestProvenanceInput>("attest-provenance");
export const verify = step<VerifyInput>("verify");
export const scanVulnerabilities = step<ScanVulnerabilitiesInput>("scan-vulnerabilities");
export const vulnGate = step<VulnGateInput>("vuln-gate");

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

// ── wait / verify ────────────────────────────────────────────────────────────
export const waitForStack = step<WaitForStackInput>("wait-for-stack");
export const waitSteadyState = step<WaitSteadyStateInput>("wait-steady-state");
export const waitClusterHealthy = step<WaitClusterHealthyInput>("wait-cluster-healthy");
export const waitEndpoint = step<WaitEndpointInput>("wait-endpoint");
export const waitJob = step<WaitJobInput>("wait-job");
export const healthGate = step<HealthGateInput>("health-gate");

// ── safety / rollback ────────────────────────────────────────────────────────
export const snapshotBefore = step<SnapshotBeforeInput>("snapshot-before");
export const rollbackPrevious = step<RollbackPreviousInput>("rollback-previous");

// ── escape hatch ─────────────────────────────────────────────────────────────
export const shell = step<ShellInput>("shell");
