import { WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

const ClusterSecretStore = createResource("K8s::ExternalSecrets::ClusterSecretStore", "k8s", {});
const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

const systemLabels = { "app.kubernetes.io/part-of": "system" };

// K8s ServiceAccount with Workload Identity annotation — the ESO ClusterSecretStore
// references this SA to exchange K8s tokens for GCP Secret Manager access tokens.
const { serviceAccount: esoK8sServiceAccount } = WorkloadIdentityServiceAccount({
  name: "external-secrets-sa",
  namespace: "system",
  gcpServiceAccountEmail: `gitlab-eso@${shared.projectId}.iam.gserviceaccount.com`,
  labels: systemLabels,
});
export { esoK8sServiceAccount };

export const gcpSecretStore = new ClusterSecretStore({
  metadata: { name: "gcp-secret-manager", labels: systemLabels },
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

// Grafana admin password synced from Secret Manager — generated once by load-outputs.sh.
// Grafana reads this via GF_SECURITY_ADMIN_PASSWORD env var.
export const grafanaAdminSecret = new ExternalSecret({
  metadata: { name: "grafana-admin", namespace: "system", labels: systemLabels },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
    target: { name: "grafana-admin" },
    data: [{ secretKey: "password", remoteRef: { key: "gitlab-grafana-admin-password" } }],
  },
});
