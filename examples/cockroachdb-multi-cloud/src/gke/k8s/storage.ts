// K8s workloads: GCE Persistent Disk StorageClass for SSD volumes.

import { StorageClass, GcePdStorageClass } from "@intentius/chant-lexicon-k8s";

const pd = GcePdStorageClass({
  name: "pd-ssd",
  type: "pd-ssd",
});

export const storageClass = new StorageClass(pd.storageClass);
