import { NamespaceEnv, NetworkPolicy, WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import type { CellConfig } from "../config";
import { shared } from "../config";

const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

export function createCell(cell: CellConfig) {
  const ns = `cell-${cell.name}`;

  const { namespace, resourceQuota, limitRange, networkPolicy: defaultDeny } = NamespaceEnv({
    name: ns,
    cpuQuota: cell.cpuQuota,
    memoryQuota: cell.memoryQuota,
    defaultDenyIngress: true,
    defaultDenyEgress: true,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "gitlab.example.com/cell": cell.name,
      "pod-security.kubernetes.io/enforce": "baseline",
    },
  });

  // Allow ingress from system namespace (ingress controller routes to cells)
  const allowIngressFromSystem = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-ingress-system`, namespace: ns },
    spec: {
      podSelector: {},
      ingress: [{
        from: [{
          namespaceSelector: {
            matchLabels: { "app.kubernetes.io/part-of": "system" },
          },
        }],
        ports: [
          { protocol: "TCP", port: 8080 },
          { protocol: "TCP", port: 8181 },
          { protocol: "TCP", port: 8443 },
        ],
      }],
      policyTypes: ["Ingress"],
    },
  });

  // Allow egress to DNS + GCP APIs + Cloud SQL + Memorystore
  const allowEgress = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-egress`, namespace: ns },
    spec: {
      podSelector: {},
      egress: [
        // DNS (kube-dns)
        { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        // GCP metadata server
        { to: [{ ipBlock: { cidr: "169.254.169.254/32" } }] },
        // Cloud SQL (private IP range)
        { to: [{ ipBlock: { cidr: "10.100.0.0/16" } }], ports: [{ protocol: "TCP", port: 5432 }] },
        // Memorystore (private IP range)
        { to: [{ ipBlock: { cidr: "10.100.0.0/16" } }], ports: [{ protocol: "TCP", port: 6379 }] },
        // GCP APIs (restricted VIP)
        { to: [{ ipBlock: { cidr: "199.36.153.4/30" } }], ports: [{ protocol: "TCP", port: 443 }] },
        // Topology Service in system namespace
        {
          to: [{ namespaceSelector: { matchLabels: { "app.kubernetes.io/part-of": "system" } } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
      policyTypes: ["Egress"],
    },
  });

  // ExternalSecrets (synced from GCP Secret Manager)
  const externalSecrets = [
    { k8sName: "gitlab-db-password", remoteKey: `gitlab-${cell.name}-db-password`, secretKey: "password" },
    { k8sName: "gitlab-redis-password", remoteKey: `gitlab-${cell.name}-redis-password`, secretKey: "password" },
    { k8sName: "gitlab-redis-cache-password", remoteKey: `gitlab-${cell.name}-redis-cache-password`, secretKey: "password" },
    { k8sName: "gitlab-root-password", remoteKey: `gitlab-${cell.name}-root-password`, secretKey: "password" },
    { k8sName: "gitlab-rails-secret", remoteKey: `gitlab-${cell.name}-rails-secret`, secretKey: "rails-secret.yml" },
    { k8sName: "gitlab-smtp-password", remoteKey: "gitlab-smtp-password", secretKey: "password" },
  ].map(({ k8sName, remoteKey, secretKey }) => new ExternalSecret({
    metadata: { name: k8sName, namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
      target: { name: k8sName },
      data: [{ secretKey, remoteRef: { key: remoteKey } }],
    },
  }));

  // Registry storage config secret (template-only, no remote data)
  const registryStorageSecret = new ExternalSecret({
    metadata: { name: "registry-storage", namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
      target: {
        name: "registry-storage",
        template: {
          data: {
            config: `{ "gcs": { "bucket": "${shared.projectId}-${cell.name}-registry" } }`,
          },
        },
      },
      data: [],
    },
  });

  // Workload Identity SA binding
  const { serviceAccount } = WorkloadIdentityServiceAccount({
    name: `${cell.name}-sa`,
    gcpServiceAccountEmail: `gitlab-${cell.name}@${shared.projectId}.iam.gserviceaccount.com`,
    namespace: ns,
  });

  // Allow all traffic within the same namespace (webservice↔gitaly, workhorse↔webservice, etc.)
  const allowSameNamespace = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-same-namespace`, namespace: ns },
    spec: {
      podSelector: {},
      ingress: [{ from: [{ podSelector: {} }] }],
      egress: [{ to: [{ podSelector: {} }] }],
      policyTypes: ["Ingress", "Egress"],
    },
  });

  return {
    namespace, resourceQuota, limitRange, defaultDeny,
    allowSameNamespace, allowIngressFromSystem, allowEgress,
    externalSecrets, registryStorageSecret,
    serviceAccount,
  };
}
