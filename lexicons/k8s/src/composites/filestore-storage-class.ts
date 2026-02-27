/**
 * FilestoreStorageClass composite — StorageClass for GCP Filestore CSI driver.
 *
 * @gke Creates a StorageClass with the `filestore.csi.storage.gke.io` provisioner.
 * Filestore provides ReadWriteMany access mode (shared across pods/nodes).
 */

export interface FilestoreStorageClassProps {
  /** StorageClass name. */
  name: string;
  /** Filestore tier (default: "standard"). */
  tier?: "standard" | "premium" | "enterprise";
  /** VPC network for the Filestore instance. */
  network?: string;
  /** Reclaim policy (default: "Delete"). */
  reclaimPolicy?: string;
  /** Volume binding mode (default: "WaitForFirstConsumer"). */
  volumeBindingMode?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
}

export interface FilestoreStorageClassResult {
  storageClass: Record<string, unknown>;
}

/**
 * Create a FilestoreStorageClass composite — returns prop objects for
 * a StorageClass with the GCP Filestore CSI provisioner.
 *
 * @gke
 * @example
 * ```ts
 * import { FilestoreStorageClass } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageClass } = FilestoreStorageClass({
 *   name: "filestore-standard",
 *   tier: "standard",
 *   network: "default",
 * });
 * ```
 */
export function FilestoreStorageClass(props: FilestoreStorageClassProps): FilestoreStorageClassResult {
  const {
    name,
    tier = "standard",
    network,
    reclaimPolicy = "Delete",
    volumeBindingMode = "WaitForFirstConsumer",
    labels: extraLabels = {},
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const parameters: Record<string, string> = {
    tier,
  };

  if (network) {
    parameters.network = network;
  }

  const storageClassProps: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "filestore.csi.storage.gke.io",
    parameters,
    reclaimPolicy,
    volumeBindingMode,
  };

  return { storageClass: storageClassProps };
}
