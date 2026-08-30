/**
 * Validate generated lexicon-azure artifacts.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";
import { CURATED_PROPERTY_TYPE_DEFS } from "./spec/parse";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  // Core compute resources
  "VirtualMachine", "VirtualMachineScaleSet", "AvailabilitySet",
  // Networking
  "VirtualNetwork", "Subnet", "NetworkInterface",
  "NetworkSecurityGroup", "PublicIPAddress", "LoadBalancer",
  // Storage
  "StorageAccount", "BlobContainer",
  // Web & App
  "WebApp", "AppServicePlan",
  // Containers
  "ManagedCluster", "ContainerRegistry",
  // Databases
  "SqlServer", "SqlDatabase",
  // Security & Identity
  "KeyVault", "ManagedIdentity",
  // Governance — org hierarchy + policy primitives (#1545).  once claimed
  // these existed when they did not; this gate keeps them from vanishing again.
  "ManagementGroup", "SubscriptionAlias", "PolicyDefinition", "PolicyAssignment",
  // DNS & Traffic
  "DnsZone", "TrafficManagerProfile",
  // Curated property types kept typed by the codegen (#438) — single source of truth.
  ...CURATED_PROPERTY_TYPE_DEFS,
];

export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-azure.json",
    requiredNames: REQUIRED_NAMES,
    // Curated property types are emitted under resource-prefixed/variant names
    // after bounding (#438), so match required names by substring.
    requiredNamesMatchSubstring: true,
    basePath,
    // chant #1475 — azure generates from a commit sha of
    // azure-resource-manager-schemas (#1144), so a fresh generate is
    // deterministic. Gate the surface on every validate: the #1144 pin left
    // the snapshot 483 entries behind until #1572 re-baselined it, because
    // nothing compared the two on a PR.
    checkSurfaceSnapshot: "always",
    coverageThresholds: {
      minPropertyPct: 1,
      minLifecyclePct: 1,
      minAttrPct: 1,
    },
  });
}
