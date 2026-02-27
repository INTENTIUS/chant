/**
 * ContainerRegistrySecure composite — Azure Container Registry with security hardening.
 *
 * A higher-level construct for deploying an ACR with
 * admin user disabled, content trust, and quarantine policy.
 */

export interface ContainerRegistrySecureProps {
  /** Registry name (5-50 chars, alphanumeric, globally unique). */
  name: string;
  /** SKU tier (default: "Premium" — required for security features). */
  sku?: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface ContainerRegistrySecureResult {
  registry: Record<string, unknown>;
}

/**
 * Create a ContainerRegistrySecure composite — returns a property object for
 * an Azure Container Registry with security best practices.
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
export function ContainerRegistrySecure(props: ContainerRegistrySecureProps): ContainerRegistrySecureResult {
  const {
    name,
    sku = "Premium",
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const registry: Record<string, unknown> = {
    type: "Microsoft.ContainerRegistry/registries",
    apiVersion: "2023-07-01",
    name,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    properties: {
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
    },
  };

  return { registry };
}
