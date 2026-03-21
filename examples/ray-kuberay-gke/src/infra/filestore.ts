// GCP Filestore instance for shared Ray training data.
//
// ENTERPRISE tier provides 99.99% SLA (vs STANDARD's 99.9%) and supports
// ReadWriteMany access from all Ray workers simultaneously.
// This instance is referenced by the FilestoreStorageClass in the K8s layer.

import { FilestoreInstance } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const filestoreInstance = new FilestoreInstance({
  metadata: {
    name: config.filestoreName,
    annotations: {
      "cnrm.cloud.google.com/project-id": config.projectId,
    },
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    // Zone within the region — Filestore ENTERPRISE is a single-zone resource.
    location: `${config.region}-a`,
    tier: "ENTERPRISE",
    fileShares: [
      {
        name: "ray_data",
        capacityGb: 1024,
      },
    ],
    networks: [
      {
        network: config.vpcName,
        modes: ["MODE_IPV4"],
      },
    ],
  },
});
