/**
 * EbsStorageClass composite — StorageClass for AWS EBS CSI driver.
 *
 * @eks Creates a StorageClass with the `ebs.csi.aws.com` provisioner.
 */

export interface EbsStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** EBS volume type (default: "gp3"). */
  type?: string;
  /** IOPS for io1/io2/gp3 volumes. */
  iops?: string | number;
  /** Throughput for gp3 volumes (MiB/s). */
  throughput?: string | number;
  /** Enable encryption (default: true). */
  encrypted?: boolean;
  /** KMS key ID for encryption. */
  kmsKeyId?: string;
  /** Filesystem type (default: "ext4"). */
  fsType?: string;
  /** Reclaim policy (default: "Delete"). */
  reclaimPolicy?: string;
  /** Volume binding mode (default: "WaitForFirstConsumer"). */
  volumeBindingMode?: string;
  /** Allow volume expansion (default: true). */
  allowVolumeExpansion?: boolean;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface EbsStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create an EbsStorageClass composite — returns prop objects for
 * a StorageClass with the EBS CSI provisioner.
 *
 * @eks
 * @example
 * ```ts
 * import { EbsStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = EbsStorageClass({
 *   name: "gp3-encrypted",
 *   type: "gp3",
 *   encrypted: true,
 * });
 * ```
 */
export function EbsStorageClass(props: EbsStorageClassProps): EbsStorageClassResult {
  const {
    name,
    type = "gp3",
    iops,
    throughput,
    encrypted = true,
    kmsKeyId,
    fsType = "ext4",
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
    type,
    fsType,
    encrypted: String(encrypted),
  };

  if (iops !== undefined) parameters.iops = String(iops);
  if (throughput !== undefined) parameters.throughput = String(throughput);
  if (kmsKeyId) parameters.kmsKeyId = kmsKeyId;

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "ebs.csi.aws.com",
    parameters,
    reclaimPolicy,
    volumeBindingMode,
    allowVolumeExpansion,
  };

  return { storageClass: storageClassProps };
}
