// K8s workloads: GCE Persistent Disk StorageClass for SSD volumes.

import { GcePdStorageClass } from "@intentius/chant-lexicon-k8s";

const pd = GcePdStorageClass({
  name: "pd-ssd",
  type: "pd-ssd",
});

export const storageClass = pd.storageClass;
