/**
 * Typed step-builder API (#658) — ergonomic sugar over the kind-literal
 * `Step`/`BuildSpec` contract. `phase("Verify", [healthGate({ path })])`
 * is exactly `phase("Verify", [{ kind: "health-gate", path }])`, but
 * with per-verb argument checking and autocomplete from each capability's own
 * `Input` type. Core exports the agnostic verbs' builders; a lexicon exports
 * its own (e.g. the aws lexicon's `cfnDeploy`, reusing the exported `step`).
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
  SignInput,
  AttestProvenanceInput,
  VerifyInput,
  ScanVulnerabilitiesInput,
  VulnGateInput,
  WaitClusterHealthyInput,
  WaitEndpointInput,
  HealthGateInput,
  ShellInput,
} from "./verbs/index";

/**
 * Build a `(input) => Step` for one deploy verb: tags the input with its
 * `kind`. Exported so a lexicon's capability plugin (e.g. the aws lexicon,
 * which owns the `cfn-deploy`/`emr-*`/… builders) can offer the same typed
 * sugar for its own verbs without re-implementing this projection.
 */
export function step<In extends object>(kind: string): (input: In) => Step {
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

// ── supply-chain security / policy ───────────────────────────────────────────
export const sign = step<SignInput>("sign");
export const attestProvenance = step<AttestProvenanceInput>("attest-provenance");
export const verify = step<VerifyInput>("verify");
export const scanVulnerabilities = step<ScanVulnerabilitiesInput>("scan-vulnerabilities");
export const vulnGate = step<VulnGateInput>("vuln-gate");

// ── wait / verify (agnostic) ─────────────────────────────────────────────────
// The cloud-specific waits (`wait-for-stack`/`wait-steady-state`/`wait-job`)
// ship as builders from the aws lexicon, alongside their capabilities.
export const waitClusterHealthy = step<WaitClusterHealthyInput>("wait-cluster-healthy");
export const waitEndpoint = step<WaitEndpointInput>("wait-endpoint");
export const healthGate = step<HealthGateInput>("health-gate");

// ── escape hatch ─────────────────────────────────────────────────────────────
export const shell = step<ShellInput>("shell");
