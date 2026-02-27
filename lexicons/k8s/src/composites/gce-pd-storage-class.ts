/**
 * GcePdStorageClass composite — StorageClass for GCE Persistent Disk CSI driver.
 *
 * @gke Creates a StorageClass with the `pd.csi.storage.gke.io` provisioner.
 */

export interface GcePdStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** PD type (default: "pd-balanced"). */
  type?: "pd-standard" | "pd-ssd" | "pd-balanced" | "pd-extreme";
  /** Replication type (default: "none"). */
  replicationType?: "none" | "regional-pd";
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

export interface GcePdStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create a GcePdStorageClass composite — returns prop objects for
 * a StorageClass with the GCE Persistent Disk CSI provisioner.
 *
 * @gke
 * @example
 * ```ts
 * import { GcePdStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = GcePdStorageClass({
 *   name: "pd-ssd",
 *   type: "pd-ssd",
 * });
 * ```
 */
export function GcePdStorageClass(props: GcePdStorageClassProps): GcePdStorageClassResult {
  const {
    name,
    type = "pd-balanced",
    replicationType = "none",
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
    "csi.storage.k8s.io/fstype": fsType,
  };

  if (replicationType !== "none") {
    parameters["replication-type"] = replicationType;
  }

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "pd.csi.storage.gke.io",
    parameters,
    reclaimPolicy,
    volumeBindingMode,
    allowVolumeExpansion,
  };

  return { storageClass: storageClassProps };
}
