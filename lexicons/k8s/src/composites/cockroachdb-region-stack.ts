/**
 * CockroachDbRegionStack composite — all K8s resources for one CockroachDB region.
 *
 * Collapses the 8-file per-region K8s pattern into a single composite call:
 * namespace, storage, CockroachDB StatefulSet, External Secrets, GCE Ingress,
 * ExternalDNS, Cloud Armor BackendConfig, TLS cert, and optional Prometheus monitoring.
 *
 * @gke Requires: External Secrets Operator (ESO), ExternalDNS (via GkeExternalDnsAgent).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { createResource } from "@intentius/chant/runtime";
import {
  NetworkPolicy,
  Deployment,
  Service,
  ConfigMap,
} from "../generated";
import { NamespaceEnv } from "./namespace-env";
import { GcePdStorageClass } from "./gce-pd-storage-class";
import { CockroachDbCluster } from "./cockroachdb-cluster";
import { GceIngress } from "./gce-ingress";
import { GkeExternalDnsAgent } from "./gke-external-dns-agent";

// ── External CRDs (not in main generated index) ──────────────────────────────────

const ClusterSecretStore = createResource("K8s::ExternalSecrets::ClusterSecretStore", "k8s", {});
const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", "k8s", {});
const BackendConfig = createResource("K8s::GKE::BackendConfig", "k8s", {});
const ManagedCertificate = createResource("K8s::NetworkingGKE::ManagedCertificate", "k8s", {});
const FrontendConfig = createResource("K8s::NetworkingGKEBeta::FrontendConfig", "k8s", {});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CockroachDbRegionCockroachConfig {
  /** Cluster name (default: "cockroachdb"). */
  name?: string;
  /** StatefulSet replicas (default: 3). */
  replicas?: number;
  /** CockroachDB image (default: "cockroachdb/cockroach:v24.3.0"). */
  image?: string;
  /** PVC storage size per node (default: "100Gi"). */
  storageSize?: string;
  /** CPU limit per pod (default: "2"). */
  cpuLimit?: string;
  /** Memory limit per pod (default: "8Gi"). */
  memoryLimit?: string;
  /** Locality flag (e.g. "cloud=gcp,region=us-east4"). */
  locality?: string;
  /** Join addresses for multi-region cluster. */
  joinAddresses?: string[];
  /**
   * Skip the cockroach init Job (set true for secondary regions).
   * Only the first region should run cockroach init.
   */
  skipInit?: boolean;
  /**
   * Mount the client certs secret into pods (needed for multi-region init via kubectl exec).
   */
  mountClientCerts?: boolean;
  /**
   * Extra DNS names to include in node cert SANs (e.g. cross-region ExternalDNS names).
   */
  extraCertNodeAddresses?: string[];
  /**
   * Domain for cross-cluster advertise address (e.g. "east.crdb.internal").
   * When set, pods advertise "${HOSTNAME}.${advertiseHostDomain}" for cross-cluster gossip.
   */
  advertiseHostDomain?: string;
}

export interface CockroachDbRegionTlsConfig {
  /**
   * GCP Secret Manager secret names to sync into K8s Secrets via External Secrets Operator.
   */
  gcpSecretNames: {
    /** CA cert secret name in GCP Secret Manager. */
    ca: string;
    /** Node cert secret name. */
    nodeCrt: string;
    /** Node cert key secret name. */
    nodeKey: string;
    /** Client root cert secret name. */
    clientRootCrt: string;
    /** Client root key secret name. */
    clientRootKey: string;
  };
}

export interface CockroachDbRegionStackConfig {
  /**
   * Short region identifier used in resource names and labels (e.g. "east").
   * Used to distinguish resources across regions.
   */
  region: string;
  /** K8s namespace for all namespaced resources (e.g. "crdb-east"). */
  namespace: string;
  /** Public UI domain for this region (e.g. "east.crdb.example.com"). */
  domain: string;
  /** Cross-cluster ExternalDNS domain (e.g. "east.crdb.internal"). */
  internalDomain: string;
  /** Root public domain for ExternalDNS domain filter (e.g. "crdb.example.com"). */
  publicRootDomain: string;

  /** GCP project ID — used in ClusterSecretStore Workload Identity config. */
  projectId: string;
  /** GKE cluster name — used in ClusterSecretStore Workload Identity config. */
  clusterName: string;
  /** GKE cluster region (e.g. "us-east4") — used in ClusterSecretStore config. */
  clusterRegion: string;
  /** GCP service account email for CRDB Workload Identity annotation on the K8s SA. */
  crdbGsaEmail: string;
  /** GCP service account email for ExternalDNS Workload Identity. */
  externalDnsGsaEmail: string;

  /** CockroachDB cluster configuration. */
  cockroachdb: CockroachDbRegionCockroachConfig;
  /** TLS certificate sync config (External Secrets Operator). */
  tls: CockroachDbRegionTlsConfig;

  /** Namespace resource quotas. */
  quota?: {
    /** Total CPU limit quota (e.g. "8"). */
    cpu?: string;
    /** Total memory limit quota (e.g. "20Gi"). */
    memory?: string;
    /** Maximum pods. */
    maxPods?: number;
  };

  /**
   * CIDRs that may send traffic to CockroachDB ports (26257 + 8080).
   * Used in the allow-cockroachdb NetworkPolicy.
   */
  allowCidrs?: string[];

  /**
   * Cloud Armor WAF configuration.
   * When set, a BackendConfig is created attaching the policy to the public service.
   */
  cloudArmor?: {
    /** Cloud Armor security policy name. */
    policyName: string;
  };

  /**
   * Emit Prometheus ConfigMap + Deployment + Service for CockroachDB metrics.
   * Uses a lightweight Prometheus scraping `/_status/vars` (default: false).
   */
  monitoring?: boolean;

  /** Additional labels for all resources. */
  labels?: Record<string, string>;
}

/**
 * Create a CockroachDbRegionStack composite — returns all K8s resources for one
 * CockroachDB region in a single call.
 *
 * Replaces: namespace.ts, storage.ts, cockroachdb.ts, external-secrets.ts,
 * ingress.ts, tls.ts, backend-config.ts, monitoring.ts (8 files → 1 call).
 *
 * @gke
 * @example
 * ```ts
 * import { CockroachDbRegionStack } from "@intentius/chant-lexicon-k8s";
 *
 * export const east = CockroachDbRegionStack({
 *   region: "east",
 *   namespace: "crdb-east",
 *   domain: `east.${CRDB_DOMAIN}`,
 *   internalDomain: `east.${INTERNAL_DOMAIN}`,
 *   publicRootDomain: CRDB_DOMAIN,
 *   projectId: GCP_PROJECT_ID,
 *   clusterName: "gke-crdb-east",
 *   clusterRegion: "us-east4",
 *   crdbGsaEmail: `gke-crdb-east-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
 *   externalDnsGsaEmail: `gke-crdb-east-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
 *   cockroachdb: {
 *     locality: "cloud=gcp,region=us-east4",
 *     joinAddresses: [...],
 *     advertiseHostDomain: `east.${INTERNAL_DOMAIN}`,
 *     skipInit: false,
 *     mountClientCerts: true,
 *   },
 *   tls: {
 *     gcpSecretNames: {
 *       ca: "crdb-ca-crt", nodeCrt: "crdb-node-crt", nodeKey: "crdb-node-key",
 *       clientRootCrt: "crdb-client-root-crt", clientRootKey: "crdb-client-root-key",
 *     },
 *   },
 *   allowCidrs: ALL_CIDRS,
 *   cloudArmor: { policyName: "crdb-ui-waf" },
 *   monitoring: true,
 * });
 * ```
 */
export const CockroachDbRegionStack = Composite<CockroachDbRegionStackConfig>((props) => {
  const {
    region,
    namespace: ns,
    domain,
    internalDomain,
    publicRootDomain,
    projectId,
    clusterName,
    clusterRegion,
    crdbGsaEmail,
    externalDnsGsaEmail,
    cockroachdb: crdbProps,
    tls,
    quota,
    allowCidrs = [],
    cloudArmor,
    monitoring = false,
    labels: extraLabels = {},
  } = props;

  const crdbName = crdbProps.name ?? "cockroachdb";

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/part-of": `cockroachdb-multi-region`,
    "app.kubernetes.io/instance": region,
    ...extraLabels,
  };

  // ── Namespace + Quotas ─────────────────────────────────────────────────────────

  const nsResult = NamespaceEnv({
    name: ns,
    ...(quota?.cpu && { cpuQuota: quota.cpu }),
    ...(quota?.memory && { memoryQuota: quota.memory }),
    ...(quota?.maxPods !== undefined && { maxPods: quota.maxPods }),
    defaultCpuRequest: "250m",
    defaultMemoryRequest: "512Mi",
    defaultCpuLimit: "1",
    defaultMemoryLimit: "4Gi",
    defaultDenyIngress: true,
    labels: {
      "pod-security.kubernetes.io/enforce": "baseline",
      "pod-security.kubernetes.io/enforce-version": "latest",
      "pod-security.kubernetes.io/warn": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
      ...commonLabels,
    },
  });

  // Allow CockroachDB inter-node (26257) + HTTP UI (8080) from all region CIDRs.
  const crdbNetworkPolicy = new NetworkPolicy(mergeDefaults({
    metadata: {
      name: "allow-cockroachdb",
      namespace: ns,
      labels: commonLabels,
    },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": crdbName } },
      policyTypes: ["Ingress"],
      ingress: allowCidrs.length > 0
        ? [{
            from: allowCidrs.map((cidr) => ({ ipBlock: { cidr } })),
            ports: [
              { protocol: "TCP", port: 26257 },
              { protocol: "TCP", port: 8080 },
            ],
          }]
        : [],
    },
  }, {}));

  // ── Storage ────────────────────────────────────────────────────────────────────

  const { storageClass } = GcePdStorageClass({
    name: "pd-ssd",
    type: "pd-ssd",
    labels: commonLabels,
  });

  // ── CockroachDB Cluster ────────────────────────────────────────────────────────

  const crdb = CockroachDbCluster({
    name: crdbName,
    namespace: ns,
    replicas: crdbProps.replicas ?? 3,
    image: crdbProps.image,
    storageSize: crdbProps.storageSize,
    storageClassName: "pd-ssd",
    cpuLimit: crdbProps.cpuLimit,
    memoryLimit: crdbProps.memoryLimit,
    locality: crdbProps.locality,
    joinAddresses: crdbProps.joinAddresses,
    secure: true,
    skipCertGen: true,
    skipInit: crdbProps.skipInit,
    mountClientCerts: crdbProps.mountClientCerts,
    advertiseHostDomain: crdbProps.advertiseHostDomain,
    extraCertNodeAddresses: crdbProps.extraCertNodeAddresses,
    labels: commonLabels,
    defaults: {
      serviceAccount: {
        metadata: {
          annotations: {
            "iam.gke.io/gcp-service-account": crdbGsaEmail,
          },
        },
      },
      publicService: {
        metadata: {
          annotations: {
            "cloud.google.com/backend-config": `{"default":"${crdbName}-ui-backend"}`,
            "cloud.google.com/app-protocols": `{"http":"HTTPS"}`,
          },
        },
      },
      headlessService: {
        metadata: {
          annotations: {
            "external-dns.alpha.kubernetes.io/hostname": internalDomain,
          },
        },
      },
    },
  });

  // ── External Secrets (TLS certs from GCP Secret Manager) ──────────────────────

  const secretStoreName = "gcp-secret-manager";

  const gcpSecretStore = new ClusterSecretStore({
    metadata: { name: secretStoreName },
    spec: {
      provider: {
        gcpsm: {
          projectID: projectId,
          auth: {
            workloadIdentity: {
              clusterLocation: clusterRegion,
              clusterName,
              serviceAccountRef: { name: "external-secrets-sa", namespace: "kube-system" },
            },
          },
        },
      },
    },
  });

  const nodeCertsSecret = new ExternalSecret({
    metadata: { name: `${crdbName}-node-certs-eso`, namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: secretStoreName, kind: "ClusterSecretStore" },
      target: { name: `${crdbName}-node-certs`, creationPolicy: "Owner" },
      data: [
        { secretKey: "ca.crt",   remoteRef: { key: tls.gcpSecretNames.ca } },
        { secretKey: "node.crt", remoteRef: { key: tls.gcpSecretNames.nodeCrt } },
        { secretKey: "node.key", remoteRef: { key: tls.gcpSecretNames.nodeKey } },
      ],
    },
  });

  const clientCertsSecret = new ExternalSecret({
    metadata: { name: `${crdbName}-client-certs-eso`, namespace: ns },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { name: secretStoreName, kind: "ClusterSecretStore" },
      target: { name: `${crdbName}-client-certs`, creationPolicy: "Owner" },
      data: [
        { secretKey: "ca.crt",           remoteRef: { key: tls.gcpSecretNames.ca } },
        { secretKey: "client.root.crt",  remoteRef: { key: tls.gcpSecretNames.clientRootCrt } },
        { secretKey: "client.root.key",  remoteRef: { key: tls.gcpSecretNames.clientRootKey } },
      ],
    },
  });

  // ── TLS: Managed Certificate + FrontendConfig ─────────────────────────────────

  const certName = `${crdbName}-ui-cert`;
  const frontendName = `${crdbName}-ui-frontend`;
  const backendName = `${crdbName}-ui-backend`;

  const crdbManagedCert = new ManagedCertificate({
    metadata: {
      name: certName,
      namespace: ns,
      labels: commonLabels,
    },
    spec: { domains: [domain] },
  });

  const crdbFrontendConfig = new FrontendConfig({
    metadata: {
      name: frontendName,
      namespace: ns,
      labels: commonLabels,
    },
    spec: {
      redirectToHttps: {
        enabled: true,
        responseCodeName: "MOVED_PERMANENTLY_DEFAULT",
      },
    },
  });

  // ── GCE Ingress ────────────────────────────────────────────────────────────────

  const { ingress: gceIngress } = GceIngress({
    name: `${crdbName}-ui`,
    hosts: [{
      hostname: domain,
      paths: [{ path: "/", serviceName: `${crdbName}-public`, servicePort: 8080 }],
    }],
    namespace: ns,
    managedCertificate: certName,
    frontendConfig: frontendName,
    labels: commonLabels,
  });

  // ── ExternalDNS ────────────────────────────────────────────────────────────────

  const dnsAgent = GkeExternalDnsAgent({
    gcpServiceAccountEmail: externalDnsGsaEmail,
    gcpProjectId: projectId,
    domainFilters: [publicRootDomain, internalDomain.split(".").slice(1).join(".")],
    txtOwnerId: clusterName,
    source: ["service", "ingress"],
    labels: commonLabels,
  });

  // ── Result object ─────────────────────────────────────────────────────────────

  const result: Record<string, any> = {
    // Namespace
    ...nsResult,
    crdbNetworkPolicy,

    // Storage
    storageClass,

    // CockroachDB
    cockroachdbServiceAccount: crdb.serviceAccount,
    cockroachdbRole: crdb.role,
    cockroachdbRoleBinding: crdb.roleBinding,
    cockroachdbClusterRole: crdb.clusterRole,
    cockroachdbClusterRoleBinding: crdb.clusterRoleBinding,
    cockroachdbPublicService: crdb.publicService,
    cockroachdbHeadlessService: crdb.headlessService,
    cockroachdbPdb: crdb.pdb,
    cockroachdbStatefulSet: crdb.statefulSet,
    ...(crdb.initJob && { cockroachdbInitJob: crdb.initJob }),

    // External Secrets
    gcpSecretStore,
    nodeCertsSecret,
    clientCertsSecret,

    // TLS
    crdbManagedCert,
    crdbFrontendConfig,

    // Ingress + ExternalDNS
    gceIngress,
    dnsDeployment: dnsAgent.deployment,
    dnsServiceAccount: dnsAgent.serviceAccount,
    dnsClusterRole: dnsAgent.clusterRole,
    dnsClusterRoleBinding: dnsAgent.clusterRoleBinding,
  };

  // Optional: Cloud Armor BackendConfig
  if (cloudArmor) {
    result.crdbBackendConfig = new BackendConfig({
      metadata: {
        name: backendName,
        namespace: ns,
        labels: commonLabels,
      },
      spec: {
        securityPolicy: { name: cloudArmor.policyName },
        healthCheck: { type: "HTTPS", requestPath: "/health", port: 8080 },
      },
    });
  }

  // Optional: Prometheus monitoring
  if (monitoring) {
    result.prometheusConfig = new ConfigMap({
      metadata: { name: "prometheus-config", namespace: ns },
      data: {
        "prometheus.yml": [
          `global:`,
          `  scrape_interval: 15s`,
          `scrape_configs:`,
          `  - job_name: "cockroachdb"`,
          `    kubernetes_sd_configs:`,
          `      - role: pod`,
          `        namespaces:`,
          `          names: ["${ns}"]`,
          `    relabel_configs:`,
          `      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]`,
          `        regex: "cockroachdb"`,
          `        action: keep`,
          `      - source_labels: [__meta_kubernetes_pod_ip]`,
          `        target_label: __address__`,
          `        replacement: "$1:8080"`,
          `      - source_labels: [__meta_kubernetes_pod_name]`,
          `        target_label: instance`,
          `    metrics_path: "/_status/vars"`,
        ].join("\n"),
      },
    } as Record<string, unknown>);

    result.prometheusDeployment = new Deployment({
      metadata: {
        name: "prometheus",
        namespace: ns,
        labels: { "app.kubernetes.io/name": "prometheus", ...commonLabels },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
        template: {
          metadata: { labels: { "app.kubernetes.io/name": "prometheus" } },
          spec: {
            containers: [{
              name: "prometheus",
              image: "prom/prometheus:v2.51.0",
              args: [
                "--config.file=/etc/prometheus/prometheus.yml",
                "--storage.tsdb.retention.time=15d",
              ],
              ports: [{ name: "http", containerPort: 9090 }],
              resources: {
                requests: { cpu: "500m", memory: "1Gi" },
                limits:   { cpu: "1",    memory: "2Gi" },
              },
              volumeMounts: [{ name: "config", mountPath: "/etc/prometheus" }],
            }],
            volumes: [{ name: "config", configMap: { name: "prometheus-config" } }],
          },
        },
      },
    } as Record<string, unknown>);

    result.prometheusService = new Service({
      metadata: { name: "prometheus", namespace: ns },
      spec: {
        selector: { "app.kubernetes.io/name": "prometheus" },
        ports: [{ name: "http", port: 9090, targetPort: "http" }],
      },
    } as Record<string, unknown>);
  }

  return result;
}, "CockroachDbRegionStack");
