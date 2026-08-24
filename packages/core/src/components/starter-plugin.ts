/**
 * The starter verb set (epic #551, #554/#557/#558), wrapped as a
 * `CapabilityPlugin` (#559) — the built-in, always-loaded plugin that
 * carries every Phase 1 capability forward under the Phase 2 plugin
 * contract with **no behavior change**.
 *
 * Migration path from Phase 1 to Phase 2: Phase 1 (`createCapabilityRegistry`,
 * ./registry.ts) constructed a `CapabilityRegistry` by registering each
 * starter verb directly. Phase 2 introduces `CapabilityPlugin` as the
 * discoverable, typed package contract (./capability-plugin.ts) that
 * mirrors how lexicons are packaged (../lexicon.ts). Rather than rewrite the
 * starter verbs, this module packages the *exact same* verb list as one
 * `CapabilityPlugin` named "starter" — so:
 *
 *  - `createCapabilityRegistry()` (./registry.ts) now builds its registry by
 *    registering `starterCapabilityPlugin.capabilities()` instead of calling
 *    `registry.register(...)` once per verb inline. Same kinds, same
 *    instances, same order, same resulting registry — verified by
 *    ./registry.test.ts, unchanged.
 *  - `buildCapabilityRegistry()` (./capability-plugin-loader.ts), the new
 *    Phase 2 entry point, always loads this plugin first, then layers any
 *    additional third-party capability plugins on top by `kind`.
 *  - The driver (./driver.ts) and every pilot (./pilots/*.pilot.ts) consume
 *    only a `CapabilityRegistry` instance and never construct one directly
 *    from verb modules, so neither needed to change for this migration —
 *    the compatibility guarantee #559 asks for.
 */

import type { Capability } from "./capability";
import {
  dockerBuildCapability,
  zipPackageCapability,
  jvmBuildCapability,
  generateSbomCapability,
  signCapability,
  attestProvenanceCapability,
  verifyCapability,
  scanVulnerabilitiesCapability,
  vulnGateCapability,
  waitClusterHealthyCapability,
  waitEndpointCapability,
  healthGateCapability,
  shellCapability,
  ensureSecretCapability,
} from "./verbs/index";
import { ownPackageVersion, type CapabilityPlugin } from "./capability-plugin";

/**
 * Every `kind` in the starter verb set, grouped by family, per epic #551 and
 * docs/components/capabilities.mdx. Source of truth (moved here from
 * ./registry.ts in #559 to avoid a module cycle: ./registry.ts's
 * `createCapabilityRegistry` depends on `starterCapabilityPlugin`, so this
 * plugin module cannot depend back on ./registry.ts). Re-exported from
 * ./registry.ts unchanged for existing importers.
 */
export const STARTER_VERB_FAMILIES = {
  build: ["docker-build", "zip-package", "jvm-build"],
  // `extract-config-bom` parses a synthesized CloudFormation template, so it
  // moved to the aws lexicon (#684) alongside the other AWS leaves; core's sbom
  // family keeps only the agnostic, artifact-type-keyed `generate-sbom`.
  sbom: ["generate-sbom"],
  supplyChainSecurity: ["sign", "attest-provenance", "verify"],
  supplyChainPolicy: ["scan-vulnerabilities", "vuln-gate"],
  // Only the *agnostic* wait/verify verbs are in the starter set; the
  // cloud-specific waits (`wait-for-stack`/`wait-steady-state`/`wait-job`) are
  // contributed by the relevant lexicon (aws) — see docs/components/cloud-boundary.
  waitVerify: ["wait-cluster-healthy", "wait-endpoint", "health-gate"],
  // generated-once secret materialization (#1829, epic #1365): read-then-write,
  // present means done; the k8s store adapter is #1830.
  secrets: ["ensure-secret"],
  escapeHatch: ["shell"],
} as const;

/**
 * Every starter-set verb, in the same registration order Phase 1's
 * `createCapabilityRegistry` used. Listed individually (not as a shared
 * array literal) for the same reason Phase 1 registered them individually:
 * each capability's own `In`/`Out` generics must be inferred from its own
 * type, not widened to a lossy common supertype.
 */
function starterCapabilities(): Array<Capability<never, unknown>> {
  return [
    dockerBuildCapability,
    zipPackageCapability,
    jvmBuildCapability,
    generateSbomCapability,
    signCapability,
    attestProvenanceCapability,
    verifyCapability,
    scanVulnerabilitiesCapability,
    vulnGateCapability,
    waitClusterHealthyCapability,
    waitEndpointCapability,
    healthGateCapability,
    ensureSecretCapability,
    shellCapability,
  ] as unknown as Array<Capability<never, unknown>>;
}

/**
 * The built-in capability plugin carrying the entire Phase 1 starter verb
 * set forward under the Phase 2 contract. Always loaded first by
 * `buildCapabilityRegistry` (./capability-plugin-loader.ts).
 */
export const starterCapabilityPlugin: CapabilityPlugin = {
  name: "starter",
  // The core package's own version (#1505) — lockstep releases bump it, so a
  // literal here would go stale every `just release`. A getter, so the
  // package.json read happens on first access rather than at import time.
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities: starterCapabilities,
  families: () => STARTER_VERB_FAMILIES,
};
