/**
 * StorageAccountSecure composite — Storage Account with security hardening.
 *
 * A higher-level construct that creates a Storage Account with
 * HTTPS-only, encryption at rest, default-deny network rules, and TLS 1.2.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { StorageAccount } from "../generated";

export interface StorageAccountSecureProps {
  /** Storage account name (3-24 chars, lowercase + digits only). */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** SKU name (default: "Standard_LRS"). */
  sku?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    storageAccount?: Partial<ConstructorParameters<typeof StorageAccount>[0]>;
  };
}

export interface StorageAccountSecureResult {
  storageAccount: InstanceType<typeof StorageAccount>;
}

/**
 * Create a StorageAccountSecure composite — returns a Storage Account
 * resource with security best practices.
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
export const StorageAccountSecure = Composite<StorageAccountSecureProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    sku = "Standard_LRS",
    tags = {},
    defaults,
  } = props;

  const storageAccount = new StorageAccount(mergeDefaults({
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
  }, defaults?.storageAccount), { apiVersion: "2023-01-01" });

  return { storageAccount };
}, "StorageAccountSecure");
