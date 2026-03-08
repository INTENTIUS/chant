// K8s workloads: Azure Disk StorageClass for Premium SSD volumes.

import { AzureDiskStorageClass } from "@intentius/chant-lexicon-k8s";

const disk = AzureDiskStorageClass({
  name: "premium-lrs",
  skuName: "Premium_LRS",
});

export const storageClass = disk.storageClass;
