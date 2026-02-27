/**
 * AzureFileStorageClass composite — StorageClass for Azure Files CSI driver.
 *
 * @aks Creates a StorageClass with the `file.csi.azure.com` provisioner.
 * Azure Files provides ReadWriteMany access mode (shared across pods/nodes).
 */

export interface AzureFileStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** Azure Files SKU name (default: "Premium_LRS"). */
  skuName?: string;
  /** Protocol for Azure Files (default: "smb"). */
  protocol?: string;
  /** Specific Azure file share name (optional; dynamically provisioned if omitted). */
  shareName?: string;
  /** Reclaim policy (default: "Delete"). */
  reclaimPolicy?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface AzureFileStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create an AzureFileStorageClass composite — returns prop objects for
 * a StorageClass with the Azure Files CSI provisioner.
 *
 * @aks
 * @example
 * ```ts
 * import { AzureFileStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = AzureFileStorageClass({
 *   name: "azure-files-shared",
 *   skuName: "Premium_LRS",
 *   protocol: "nfs",
 * });
 * ```
 */
export function AzureFileStorageClass(props: AzureFileStorageClassProps): AzureFileStorageClassResult {
  const {
    name,
    skuName = "Premium_LRS",
    protocol = "smb",
    shareName,
    reclaimPolicy = "Delete",
    labels: extraLabels = {},
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const parameters: Record<string, string> = {
    skuName,
    protocol,
  };

  if (shareName) parameters.shareName = shareName;

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "file.csi.azure.com",
    parameters,
    reclaimPolicy,
  };

  return { storageClass: storageClassProps };
}
