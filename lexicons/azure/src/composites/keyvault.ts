/**
 * KeyVaultSecure composite — Key Vault with security hardening.
 *
 * A higher-level construct for deploying an Azure Key Vault with
 * soft delete, purge protection, and RBAC-ready access policies.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { KeyVault } from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    vault?: Partial<ConstructorParameters<typeof KeyVault>[0]>;
  };
}

export interface KeyVaultSecureResult {
  vault: InstanceType<typeof KeyVault>;
}

/**
 * Create a KeyVaultSecure composite — returns a Key Vault
 * with security best practices.
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
export const KeyVaultSecure = Composite<KeyVaultSecureProps>((props) => {
  const {
    name,
    tenantId,
    accessPolicies = [],
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const vault = new KeyVault(mergeDefaults({
    name,
    location,
    tags: commonTags,
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
  }, defaults?.vault), { apiVersion: "2023-02-01" });

  return { vault };
}, "KeyVaultSecure");
