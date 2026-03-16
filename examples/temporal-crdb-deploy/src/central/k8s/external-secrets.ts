// External Secrets: ClusterSecretStore + ExternalSecrets for CockroachDB TLS certs.

import { createResource } from "@intentius/chant/runtime";
import { config } from "../config";

const ClusterSecretStore = createResource("K8s::ExternalSecrets::ClusterSecretStore", "k8s", {});
const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

export const gcpSecretStore = new ClusterSecretStore({
  metadata: { name: "gcp-secret-manager" },
  spec: {
    provider: {
      gcpsm: {
        projectID: config.projectId,
        auth: {
          workloadIdentity: {
            clusterLocation: config.region,
            clusterName: config.clusterName,
            serviceAccountRef: { name: "external-secrets-sa", namespace: "kube-system" },
          },
        },
      },
    },
  },
});

export const nodeCertsSecret = new ExternalSecret({
  metadata: { name: "cockroachdb-node-certs-eso", namespace: "crdb-central" },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
    target: { name: "cockroachdb-node-certs", creationPolicy: "Owner" },
    data: [
      { secretKey: "ca.crt", remoteRef: { key: "crdb-ca-crt" } },
      { secretKey: "node.crt", remoteRef: { key: "crdb-node-crt" } },
      { secretKey: "node.key", remoteRef: { key: "crdb-node-key" } },
    ],
  },
});

export const clientCertsSecret = new ExternalSecret({
  metadata: { name: "cockroachdb-client-certs-eso", namespace: "crdb-central" },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
    target: { name: "cockroachdb-client-certs", creationPolicy: "Owner" },
    data: [
      { secretKey: "ca.crt", remoteRef: { key: "crdb-ca-crt" } },
      { secretKey: "client.root.crt", remoteRef: { key: "crdb-client-root-crt" } },
      { secretKey: "client.root.key", remoteRef: { key: "crdb-client-root-key" } },
    ],
  },
});
