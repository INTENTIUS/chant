/**
 * FilestoreStorageClass composite — StorageClass for GCP Filestore CSI driver.
 *
 * @gke Creates a StorageClass with the `filestore.csi.storage.gke.io` provisioner.
 * Filestore provides ReadWriteMany access mode (shared across pods/nodes).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { StorageClass } from "../generated";

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
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    storageClass?: Partial<Record<string, unknown>>;
  };
}

export interface FilestoreStorageClassResult {
  storageClass: InstanceType<typeof StorageClass>;
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
export const FilestoreStorageClass = Composite<FilestoreStorageClassProps>((props) => {
  const {
    name,
    tier = "standard",
    network,
    reclaimPolicy = "Delete",
    volumeBindingMode = "WaitForFirstConsumer",
    labels: extraLabels = {},
    defaults: defs,
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

  const storageClass = new StorageClass(mergeDefaults({
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    provisioner: "filestore.csi.storage.gke.io",
    parameters,
    reclaimPolicy,
    volumeBindingMode,
  }, defs?.storageClass));

  return { storageClass };
}, "FilestoreStorageClass");
