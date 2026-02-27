/**
 * AzureDiskStorageClass composite — StorageClass for Azure Disk CSI driver.
 *
 * @aks Creates a StorageClass with the `disk.csi.azure.com` provisioner.
 */

export interface AzureDiskStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** Azure Disk SKU name (default: "Premium_LRS"). */
  skuName?: string;
  /** OS disk caching mode (default: "ReadOnly"). */
  cachingMode?: string;
  /** Network access policy (default: "AllowAll"). */
  networkAccessPolicy?: string;
  /** Reclaim policy (default: "Delete"). */
  reclaimPolicy?: string;
  /** Volume binding mode (default: "WaitForFirstConsumer"). */
  volumeBindingMode?: string;
  /** Allow volume expansion (default: true). */
  allowVolumeExpansion?: boolean;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface AzureDiskStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create an AzureDiskStorageClass composite — returns prop objects for
 * a StorageClass with the Azure Disk CSI provisioner.
 *
 * @aks
 * @example
 * ```ts
 * import { AzureDiskStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = AzureDiskStorageClass({
 *   name: "premium-disk",
 *   skuName: "Premium_LRS",
 * });
 * ```
 */
export function AzureDiskStorageClass(props: AzureDiskStorageClassProps): AzureDiskStorageClassResult {
  const {
    name,
    skuName = "Premium_LRS",
    cachingMode = "ReadOnly",
    networkAccessPolicy = "AllowAll",
    reclaimPolicy = "Delete",
    volumeBindingMode = "WaitForFirstConsumer",
    allowVolumeExpansion = true,
    labels: extraLabels = {},
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const parameters: Record<string, string> = {
    skuName,
    cachingMode,
    networkAccessPolicy,
  };

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "disk.csi.azure.com",
    parameters,
    reclaimPolicy,
    volumeBindingMode,
    allowVolumeExpansion,
  };

  return { storageClass: storageClassProps };
}
