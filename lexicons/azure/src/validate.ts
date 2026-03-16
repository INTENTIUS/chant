/**
 * Validate generated lexicon-azure artifacts.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

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
  // DNS & Traffic
  "DnsZone", "TrafficManagerProfile",
  // Property types
  "Sku", "Identity", "NetworkProfile", "StorageProfile",
  "OsDisk", "ImageReference", "IpConfiguration",
  "SecurityRule", "SubnetProperties", "SiteConfig",
];

export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-azure.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
    coverageThresholds: {
      minPropertyPct: 1,
      minLifecyclePct: 1,
      minAttrPct: 1,
    },
  });
}
