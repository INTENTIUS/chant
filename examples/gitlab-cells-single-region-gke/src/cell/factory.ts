import { NamespaceEnv, NetworkPolicy, WorkloadIdentityServiceAccount, ServiceAccount, ConfigMap, Deployment, Secret } from "@intentius/chant-lexicon-k8s";
import { createResource } from "@intentius/chant/runtime";
import type { CellConfig } from "../config";
import { shared } from "../config";

const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});

export function createCell(cell: CellConfig) {
  const ns = `cell-${cell.name}`;
  const cellLabels = { "app.kubernetes.io/part-of": "cells", "gitlab.example.com/cell": cell.name };

  const { namespace, resourceQuota, limitRange, networkPolicy: defaultDeny } = NamespaceEnv({
    name: ns,
    cpuQuota: cell.cpuQuota,
    memoryQuota: cell.memoryQuota,
    // LimitRange defaults: low-enough to satisfy ResourceQuota but high-enough
    // not to conflict with GitLab components (webservice requests ~2.5Gi by default).
    defaultCpuRequest: "100m",
    defaultCpuLimit: "2",
    defaultMemoryRequest: "128Mi",
    defaultMemoryLimit: "4Gi",
    defaultDenyIngress: true,
    defaultDenyEgress: true,
    labels: {
      "app.kubernetes.io/part-of": "cells",
      "gitlab.example.com/cell": cell.name,
      "gitlab.example.com/canary": cell.canary ? "true" : "false",
      "pod-security.kubernetes.io/enforce": "baseline",
    },
  });

  // Allow ingress from system namespace (cell-router proxies to cells)
  const allowIngressFromSystem = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-ingress-system`, namespace: ns, labels: cellLabels },
    spec: {
      podSelector: {},
      ingress: [{
        from: [{
          namespaceSelector: {
            matchLabels: { "app.kubernetes.io/part-of": "system" },
          },
        }],
        ports: [
          { protocol: "TCP", port: 8080 },  // puma/rails (API, /-/health, etc.)
          // Port 8181 is the workhorse TCP listener. Git HTTP clone/push MUST go
          // through workhorse for JWT generation; direct port 8080 returns 403.
          { protocol: "TCP", port: 8181 },  // workhorse (required for git HTTP)
          { protocol: "TCP", port: 8443 },
          { protocol: "TCP", port: 5000 },  // registry
        ],
      }],
      policyTypes: ["Ingress"],
    },
  });

  // Allow egress to DNS + GCP APIs + Cloud SQL + Memorystore
  const allowEgress = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-egress`, namespace: ns, labels: cellLabels },
    spec: {
      podSelector: {},
      egress: [
        // DNS (kube-dns)
        { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        // GCP metadata server (link-local; allow full 169.254.0.0/16 + node subnet for GKE metadata proxy on port 988)
        { to: [{ ipBlock: { cidr: "169.254.0.0/16" } }] },
        // Node subnet — covers GKE metadata proxy (hostPort 988 on node IP) and master private endpoint
        { to: [{ ipBlock: { cidr: shared.nodeSubnetCidr } }] },
        // Cloud SQL and Memorystore (GCP private service access range)
        { to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ protocol: "TCP", port: 5432 }] },
        { to: [{ ipBlock: { cidr: "10.0.0.0/8" } }], ports: [{ protocol: "TCP", port: 6379 }] },
        // All HTTPS egress — covers GCS/GCP APIs (which resolve to public IPs even on Private Google Access),
        // K8s API server (ClusterIP 10.8.x), SMTP, Let's Encrypt, etc.
        { ports: [{ protocol: "TCP", port: 443 }] },
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
    { k8sName: "gitlab-rails-secret", remoteKey: `gitlab-${cell.name}-rails-secret`, secretKey: "secrets.yml" },  // Helm chart volume projection expects key "secrets.yml"
    { k8sName: "gitlab-smtp-password", remoteKey: "gitlab-smtp-password", secretKey: "password" },
  ].map(({ k8sName, remoteKey, secretKey }) => new ExternalSecret({
    metadata: { name: k8sName, namespace: ns, labels: cellLabels },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: "gcp-secret-manager", kind: "ClusterSecretStore" },
      target: { name: k8sName },
      data: [{ secretKey, remoteRef: { key: remoteKey } }],
    },
  }));

  // Registry storage config secret (static GCS bucket config — not sensitive)
  const registryStorageSecret = new Secret({
    metadata: { name: "registry-storage", namespace: ns, labels: cellLabels },
    stringData: {
      // Must be YAML (not JSON) — configure script indents and inserts this into config.yml
      config: `gcs:\n  bucket: "${shared.projectId}-${cell.name}-registry"\n`,
    },
  });

  // GitLab object store connection — uses Workload Identity (no credentials needed).
  // The cell SA's GCP SA (gitlab-${cell.name}) has objectAdmin on all storage buckets.
  const objectStoreConnectionSecret = new Secret({
    metadata: { name: "gitlab-object-store-connection", namespace: ns, labels: cellLabels },
    stringData: {
      connection: '{"provider":"Google","google_application_default":true}',
    },
  });

  // Workload Identity SA binding (named cell SA used by cell-specific runners + future named resources)
  const { serviceAccount } = WorkloadIdentityServiceAccount({
    name: `${cell.name}-sa`,
    gcpServiceAccountEmail: `gitlab-${cell.name}@${shared.projectId}.iam.gserviceaccount.com`,
    namespace: ns,
    labels: cellLabels,
  });

  // Annotate the `default` SA so Helm chart components (registry, webservice, etc.)
  // get GCS access via Workload Identity without needing explicit service account config per component.
  const defaultServiceAccount = new ServiceAccount({
    metadata: {
      name: "default",
      namespace: ns,
      labels: cellLabels,
      annotations: {
        "iam.gke.io/gcp-service-account": `gitlab-${cell.name}@${shared.projectId}.iam.gserviceaccount.com`,
      },
    },
  });

  // Allow all traffic within the same namespace (webservice↔gitaly, workhorse↔webservice, etc.)
  const allowSameNamespace = new NetworkPolicy({
    metadata: { name: `${cell.name}-allow-same-namespace`, namespace: ns, labels: cellLabels },
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
    metadata: { name: `${cell.name}-runner`, namespace: ns, labels: cellLabels },
  });

  const runnerConfig = new ConfigMap({
    metadata: { name: `${cell.name}-runner-config`, namespace: ns, labels: cellLabels },
    data: {
      "config.toml": `
concurrent = ${cell.runnerConcurrency}
[[runners]]
  name = "${cell.name}-cell-runner"
  url = "https://gitlab.${cell.host}"
  # Token format: glrt-t${cell.cellId}_<random>
  # The t${cell.cellId}_ prefix is a routable token — the HTTP router
  # extracts it stateless without consulting the Topology Service.
  # Token file written by the register-runners pipeline job via K8s secret.
  token_file = "/secrets/auth_token"
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
            volumeMounts: [
              { name: "config", mountPath: "/etc/gitlab-runner" },
              { name: "runner-token", mountPath: "/secrets/auth_token", subPath: "token" },
            ],
          }],
          volumes: [
            { name: "config", configMap: { name: `${cell.name}-runner-config` } },
            { name: "runner-token", secret: { secretName: `${cell.name}-runner-token`, optional: true } },
          ],
        },
      },
    },
  });

  // Allow runner pods egress to the system namespace (cell-router + ingress)
  // for runner registration and job polling against this cell's GitLab API.
  const runnerAllowEgressToSystem = new NetworkPolicy({
    metadata: { name: `${cell.name}-runner-allow-egress-system`, namespace: ns, labels: cellLabels },
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
    externalSecrets, registryStorageSecret, objectStoreConnectionSecret,
    serviceAccount, defaultServiceAccount,
    runnerServiceAccount, runnerConfig, runnerDeployment, runnerAllowEgressToSystem,
  };
}
