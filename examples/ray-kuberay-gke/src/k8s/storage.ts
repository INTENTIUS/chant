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

import { Job, PersistentVolume } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// One-time job that sets Filestore share permissions so the ray user (uid 1000)
// can write training data. Runs as root via busybox, exits immediately.
// kubectl apply is idempotent — the job won't re-run if it already succeeded.
export const filestoreInit = new Job({
  metadata: {
    name: "filestore-init",
    namespace: config.namespace,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    template: {
      spec: {
        restartPolicy: "OnFailure",
        containers: [
          {
            name: "init",
            image: "busybox:1.36",
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", "chmod 777 /mnt/ray-data && echo 'permissions set'"],
            resources: { requests: { cpu: "50m", memory: "32Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
            // runAsNonRoot: false is intentional — chmod on an NFS root-owned dir requires root.
            securityContext: { runAsNonRoot: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            volumeMounts: [{ name: "shared-data", mountPath: "/mnt/ray-data" }],
          },
        ],
        volumes: [
          { name: "shared-data", persistentVolumeClaim: { claimName: "ray-shared" } },
        ],
      },
    },
  },
});

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
