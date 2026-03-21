// Static NFS PersistentVolume backed by the GCP Filestore instance created
// in the infra layer.
//
// Why static instead of dynamic CSI provisioning:
//   - Dynamic provisioning (FilestoreStorageClass) requires the Filestore CSI
//     driver addon to be enabled on the cluster.
//   - Static NFS PV works with any GKE cluster out of the box — the NFS client
//     is built into the Linux kernel.
//   - The Filestore instance is already managed by Config Connector (infra layer),
//     so dynamic CSI provisioning would create a redundant second instance.
//
// After `just deploy-infra`, get the Filestore IP with:
//   gcloud filestore instances describe ray-filestore \
//     --zone ${GCP_REGION}-a --format='value(networks[0].ipAddresses[0])'
// Then set FILESTORE_IP before `npm run build:k8s`.

import { PersistentVolume } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// Static PV bound to the Filestore share.
// The claimRef ensures this PV is reserved exclusively for the ray-shared PVC.
export const sharedDataPv = new PersistentVolume({
  metadata: {
    name: "ray-shared-pv",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    capacity: { storage: "1Ti" },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: config.filestoreStorageClass,
    nfs: {
      server: config.filestoreIp,
      path: "/ray_data",
    },
    claimRef: {
      namespace: config.namespace,
      name: "ray-shared",
    },
  },
});
