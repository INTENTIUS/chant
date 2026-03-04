// K8s workloads: EBS StorageClass for gp3 encrypted volumes.

import { StorageClass, EbsStorageClass } from "@intentius/chant-lexicon-k8s";

const ebs = EbsStorageClass({
  name: "gp3-encrypted",
  volumeType: "gp3",
  encrypted: true,
  iops: "3000",
  throughput: "125",
});

export const storageClass = new StorageClass(ebs.storageClass);
