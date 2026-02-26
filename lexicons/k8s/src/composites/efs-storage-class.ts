/**
 * EfsStorageClass composite — StorageClass for AWS EFS CSI driver.
 *
 * @eks Creates a StorageClass with the `efs.csi.aws.com` provisioner.
 * EFS provides ReadWriteMany access mode (shared across pods/nodes).
 */

export interface EfsStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** EFS filesystem ID (required). */
  fileSystemId: string;
  /** Directory permissions (default: "700"). */
  directoryPerms?: string;
  /** Base path for dynamic provisioning (default: "/dynamic_provisioning"). */
  basePath?: string;
  /** Reclaim policy (default: "Delete"). */
  reclaimPolicy?: string;
  /** Provisioning mode (default: "efs-ap"). */
  provisioningMode?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface EfsStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create an EfsStorageClass composite — returns prop objects for
 * a StorageClass with the EFS CSI provisioner.
 *
 * @eks
 * @example
 * ```ts
 * import { EfsStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = EfsStorageClass({
 *   name: "efs-shared",
 *   fileSystemId: "fs-12345678",
 * });
 * ```
 */
export function EfsStorageClass(props: EfsStorageClassProps): EfsStorageClassResult {
  const {
    name,
    fileSystemId,
    directoryPerms = "700",
    basePath = "/dynamic_provisioning",
    reclaimPolicy = "Delete",
    provisioningMode = "efs-ap",
    labels: extraLabels = {},
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "efs.csi.aws.com",
    parameters: {
      provisioningMode,
      fileSystemId,
      directoryPerms,
      basePath,
    },
    reclaimPolicy,
  };

  return { storageClass: storageClassProps };
}
