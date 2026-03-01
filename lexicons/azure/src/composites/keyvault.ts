/**
 * KeyVaultSecure composite — Key Vault with security hardening.
 *
 * A higher-level construct for deploying an Azure Key Vault with
 * soft delete, purge protection, and RBAC-ready access policies.
 */

import { markAsAzureResource } from "./from-arm";

export interface KeyVaultSecureProps {
  /** Key vault name (3-24 chars, globally unique). */
  name: string;
  /** Azure AD tenant ID. */
  tenantId: string;
  /** Access policies (default: empty — use RBAC or add policies later). */
  accessPolicies?: Array<{
    tenantId: string;
    objectId: string;
    permissions: {
      keys?: string[];
      secrets?: string[];
      certificates?: string[];
    };
  }>;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface KeyVaultSecureResult {
  vault: Record<string, unknown>;
}

/**
 * Create a KeyVaultSecure composite — returns a property object for
 * a Key Vault with security best practices.
 *
 * @example
 * ```ts
 * import { KeyVaultSecure } from "@intentius/chant-lexicon-azure";
 *
 * const { vault } = KeyVaultSecure({
 *   name: "my-keyvault",
 *   tenantId: "00000000-0000-0000-0000-000000000000",
 *   accessPolicies: [
 *     {
 *       tenantId: "00000000-0000-0000-0000-000000000000",
 *       objectId: "11111111-1111-1111-1111-111111111111",
 *       permissions: { secrets: ["get", "list", "set"] },
 *     },
 *   ],
 * });
 *
 * export { vault };
 * ```
 */
export function KeyVaultSecure(props: KeyVaultSecureProps): KeyVaultSecureResult {
  const {
    name,
    tenantId,
    accessPolicies = [],
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const vault: Record<string, unknown> = {
    type: "Microsoft.KeyVault/vaults",
    apiVersion: "2023-02-01",
    name,
    location,
    tags: commonTags,
    properties: {
      tenantId,
      sku: {
        family: "A",
        name: "standard",
      },
      accessPolicies: accessPolicies.map((policy) => ({
        tenantId: policy.tenantId,
        objectId: policy.objectId,
        permissions: {
          ...(policy.permissions.keys && { keys: policy.permissions.keys }),
          ...(policy.permissions.secrets && { secrets: policy.permissions.secrets }),
          ...(policy.permissions.certificates && { certificates: policy.permissions.certificates }),
        },
      })),
      enabledForDeployment: false,
      enabledForDiskEncryption: false,
      enabledForTemplateDeployment: false,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 90,
      enablePurgeProtection: true,
      enableRbacAuthorization: false,
      networkAcls: {
        bypass: "AzureServices",
        defaultAction: "Allow",
      },
    },
  };

  markAsAzureResource(vault);

  return { vault };
}
