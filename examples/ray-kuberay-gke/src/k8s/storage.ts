// FilestoreStorageClass for the GCP Filestore CSI driver.
//
// The CSI driver provisions ReadWriteMany volumes backed by the Filestore
// ENTERPRISE instance created in the infra layer. The RayCluster composite
// references this StorageClass via sharedStorage.storageClass.
//
// Prerequisites:
//   - GCP Filestore CSI driver must be enabled on the GKE cluster.
//     Enable via: gcloud container clusters update <name> \
//       --update-addons=GcpFilestoreCsiDriver=ENABLED --region <region>

import { FilestoreStorageClass } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

export const { storageClass } = FilestoreStorageClass({
  name: config.filestoreStorageClass,
  tier: "enterprise",
  network: config.vpcName,
  reclaimPolicy: "Retain",   // Retain — training data is precious
  volumeBindingMode: "WaitForFirstConsumer",
});
