/**
 * StorageAccountSecure composite — Storage Account with security hardening.
 *
 * A higher-level construct that creates a Storage Account with
 * HTTPS-only, encryption at rest, default-deny network rules, and TLS 1.2.
 */

export interface StorageAccountSecureProps {
  /** Storage account name (3-24 chars, lowercase + digits only). */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** SKU name (default: "Standard_LRS"). */
  sku?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface StorageAccountSecureResult {
  storageAccount: Record<string, unknown>;
}

/**
 * Create a StorageAccountSecure composite — returns a property object for
 * an ARM Storage Account resource with security best practices.
 *
 * @example
 * ```ts
 * import { StorageAccountSecure } from "@intentius/chant-lexicon-azure";
 *
 * const { storageAccount } = StorageAccountSecure({
 *   name: "myappstorage01",
 *   sku: "Standard_GRS",
 *   tags: { environment: "production" },
 * });
 *
 * export { storageAccount };
 * ```
 */
export function StorageAccountSecure(props: StorageAccountSecureProps): StorageAccountSecureResult {
  const {
    name,
    location = "[resourceGroup().location]",
    sku = "Standard_LRS",
    tags = {},
  } = props;

  const storageAccount: Record<string, unknown> = {
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    name,
    location,
    tags: {
      "managed-by": "chant",
      ...tags,
    },
    sku: {
      name: sku,
    },
    kind: "StorageV2",
    properties: {
      supportsHttpsTrafficOnly: true,
      minimumTlsVersion: "TLS1_2",
      allowBlobPublicAccess: false,
      encryption: {
        services: {
          blob: { enabled: true, keyType: "Account" },
          file: { enabled: true, keyType: "Account" },
          table: { enabled: true, keyType: "Account" },
          queue: { enabled: true, keyType: "Account" },
        },
        keySource: "Microsoft.Storage",
      },
      networkAcls: {
        bypass: "AzureServices",
        defaultAction: "Deny",
        ipRules: [],
        virtualNetworkRules: [],
      },
    },
  };

  return { storageAccount };
}
