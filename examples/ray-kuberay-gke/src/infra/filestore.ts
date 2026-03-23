// GCP Filestore instance for shared Ray training data.
//
// BASIC_HDD: NFS share accessible by all Ray workers simultaneously (ReadWriteMany).
// For production, upgrade to ENTERPRISE tier for 99.99% SLA and regional HA — but
// ENTERPRISE requires a quota increase (default quota is 0). BASIC_HDD works out
// of the box and is sufficient for development and moderate workloads.
// This instance is referenced by the FilestoreStorageClass in the K8s layer.

import { FilestoreInstance } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const filestoreInstance = new FilestoreInstance({
  metadata: {
    name: config.filestoreName,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  // BASIC_HDD is zonal — use a zone within the region.
  // ENTERPRISE requires a quota increase; BASIC_HDD works on new projects.
  location: `${config.region}-a`,
  tier: "BASIC_HDD",
  projectRef: { external: config.projectId },
  fileShares: [
    {
      name: "ray_data",
      capacityGb: 1024,
    },
  ],
  networks: [
    {
      networkRef: { external: `projects/${config.projectId}/global/networks/${config.vpcName}` },
      modes: ["MODE_IPV4"],
    },
  ],
});
