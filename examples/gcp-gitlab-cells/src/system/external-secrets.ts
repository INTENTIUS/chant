import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

const ClusterSecretStore = createResource("K8s::ExternalSecrets::ClusterSecretStore", "k8s", {});

export const gcpSecretStore = new ClusterSecretStore({
  metadata: { name: "gcp-secret-manager" },
  spec: {
    provider: {
      gcpsm: {
        projectID: shared.projectId,
        auth: {
          workloadIdentity: {
            clusterLocation: shared.region,
            clusterName: shared.clusterName,
            serviceAccountRef: { name: "external-secrets-sa", namespace: "system" },
          },
        },
      },
    },
  },
});
