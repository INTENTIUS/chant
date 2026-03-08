/**
 * ContainerRegistrySecure composite — Azure Container Registry with security hardening.
 *
 * A higher-level construct for deploying an ACR with
 * admin user disabled, content trust, and quarantine policy.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { ContainerRegistry } from "../generated";

export interface ContainerRegistrySecureProps {
  /** Registry name (5-50 chars, alphanumeric, globally unique). */
  name: string;
  /** SKU tier (default: "Premium" — required for security features). */
  sku?: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    registry?: Partial<ConstructorParameters<typeof ContainerRegistry>[0]>;
  };
}

export interface ContainerRegistrySecureResult {
  registry: InstanceType<typeof ContainerRegistry>;
}

/**
 * Create a ContainerRegistrySecure composite — returns an
 * Azure Container Registry with security best practices.
 *
 * @example
 * ```ts
 * import { ContainerRegistrySecure } from "@intentius/chant-lexicon-azure";
 *
 * const { registry } = ContainerRegistrySecure({
 *   name: "myacr01",
 *   sku: "Premium",
 *   tags: { environment: "production" },
 * });
 *
 * export { registry };
 * ```
 */
export const ContainerRegistrySecure = Composite<ContainerRegistrySecureProps>((props) => {
  const {
    name,
    sku = "Premium",
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const registry = new ContainerRegistry(mergeDefaults({
    name,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    adminUserEnabled: false,
    publicNetworkAccess: "Enabled",
    networkRuleBypassOptions: "AzureServices",
    zoneRedundancy: "Disabled",
    policies: {
      quarantinePolicy: {
        status: "enabled",
      },
      trustPolicy: {
        type: "Notary",
        status: "enabled",
      },
      retentionPolicy: {
        days: 30,
        status: "enabled",
      },
    },
    encryption: {
      status: "disabled",
    },
    dataEndpointEnabled: false,
  }, defaults?.registry), { apiVersion: "2023-07-01" });

  return { registry };
}, "ContainerRegistrySecure");
