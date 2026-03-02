// K8s workloads: Azure Disk StorageClass for Premium SSD volumes.

import { StorageClass, AzureDiskStorageClass } from "@intentius/chant-lexicon-k8s";

const disk = AzureDiskStorageClass({
  name: "premium-lrs-default",
  skuName: "Premium_LRS",
});

export const storageClass = new StorageClass(disk.storageClass);
