// K8s workloads: GCE Persistent Disk StorageClass for balanced SSD volumes.

import { StorageClass, GcePdStorageClass } from "@intentius/chant-lexicon-k8s";

const pd = GcePdStorageClass({
  name: "pd-balanced-default",
  type: "pd-balanced",
});

export const storageClass = new StorageClass(pd.storageClass);
