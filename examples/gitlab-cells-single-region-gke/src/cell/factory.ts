import { NamespaceEnv, NetworkPolicy, WorkloadIdentityServiceAccount, ServiceAccount, ConfigMap, Deployment, Secret } from "@intentius/chant-lexicon-k8s";
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
    // LimitRange defaults ensure pods without explicit limits satisfy the ResourceQuota
    defaultCpuRequest: "100m",
    defaultCpuLimit: "2",
    defaultMemoryRequest: "128Mi",
    defaultMemoryLimit: "2Gi",
    defaultDenyIngress: true,
    defaultDenyEgress: true,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "gitlab.example.com/cell": cell.name,
      "pod-security.kubernetes.io/enforce": "baseline",
    },
  });

  // Allow ingress from system namespace (cell-router proxies to cells)
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
        // Cloud SQL and Memorystore (GCP private service access range)
        { to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ protocol: "TCP", port: 5432 }] },
        { to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ protocol: "TCP", port: 6379 }] },
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

  // Registry storage config secret (static GCS bucket config — not sensitive)
  const registryStorageSecret = new Secret({
    metadata: { name: "registry-storage", namespace: ns },
    stringData: {
      config: `{"gcs":{"bucket":"${shared.projectId}-${cell.name}-registry"}}`,
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

  // --- Per-cell runner ---
  // Each cell gets its own runner that registers to that cell's GitLab instance.
  // The runner token embeds cell_${cellId}_ prefix (routable token format) so
  // the HTTP router can resolve the correct cell from the token alone — no
  // Topology Service lookup needed for CI job dispatching.

  const runnerServiceAccount = new ServiceAccount({
    metadata: { name: `${cell.name}-runner`, namespace: ns },
  });

  const runnerConfig = new ConfigMap({
    metadata: { name: `${cell.name}-runner-config`, namespace: ns },
    data: {
      "config.toml": `
concurrent = ${cell.runnerConcurrency}
[[runners]]
  name = "${cell.name}-cell-runner"
  url = "https://${cell.host}"
  # Token format: glrt-cell_${cell.cellId}_${cell.name}
  # The cell_${cell.cellId}_ prefix is a routable token — the HTTP router
  # extracts it stateless without consulting the Topology Service.
  # Actual token is injected by the register-runners pipeline job.
  token = "$RUNNER_TOKEN"
  executor = "kubernetes"
  [runners.kubernetes]
    namespace = "${ns}"
    service_account = "${cell.name}-runner"
    image = "alpine:latest"
`,
    },
  });

  const runnerDeployment = new Deployment({
    metadata: {
      name: `${cell.name}-runner`,
      namespace: ns,
      labels: {
        "app.kubernetes.io/name": `${cell.name}-runner`,
        "app.kubernetes.io/part-of": "cells",
        "gitlab.example.com/cell": cell.name,
      },
    },
    spec: {
      replicas: cell.runnerReplicas,
      selector: { matchLabels: { "app.kubernetes.io/name": `${cell.name}-runner` } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": `${cell.name}-runner` } },
        spec: {
          serviceAccountName: `${cell.name}-runner`,
          containers: [{
            name: "runner",
            image: shared.runnerImage,
            command: ["gitlab-runner", "run"],
            volumeMounts: [{ name: "config", mountPath: "/etc/gitlab-runner" }],
          }],
          volumes: [{ name: "config", configMap: { name: `${cell.name}-runner-config` } }],
        },
      },
    },
  });

  // Allow runner pods egress to the system namespace (cell-router + ingress)
  // for runner registration and job polling against this cell's GitLab API.
  const runnerAllowEgressToSystem = new NetworkPolicy({
    metadata: { name: `${cell.name}-runner-allow-egress-system`, namespace: ns },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": `${cell.name}-runner` } },
      egress: [{
        to: [{ namespaceSelector: { matchLabels: { "app.kubernetes.io/part-of": "system" } } }],
        ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 8080 }],
      }],
      policyTypes: ["Egress"],
    },
  });

  return {
    namespace, resourceQuota, limitRange, defaultDeny,
    allowSameNamespace, allowIngressFromSystem, allowEgress,
    externalSecrets, registryStorageSecret,
    serviceAccount,
    runnerServiceAccount, runnerConfig, runnerDeployment, runnerAllowEgressToSystem,
  };
}
