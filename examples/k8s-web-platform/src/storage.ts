// EfsStorageClass: shared EFS storage for the platform.

import {
  StorageClass,
  EfsStorageClass,
} from "@intentius/chant-lexicon-k8s";

const efs = EfsStorageClass({
  name: "efs-shared",
  fileSystemId: "fs-0123456789abcdef0",
  directoryPerms: "755",
  basePath: "/web-platform",
});

export const efsStorageClass = new StorageClass(efs.storageClass);
