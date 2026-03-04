/**
 * CockroachDbCluster composite — StatefulSet + Services + RBAC + PDB + Jobs.
 *
 * Deploys a CockroachDB cluster on Kubernetes with TLS support via self-signed
 * certificates. Produces all K8s resources needed for a single cloud's slice of
 * a CockroachDB cluster (typically 3 nodes). Multi-cloud deployments use one
 * CockroachDbCluster per cloud, sharing joinAddresses across clouds.
 */

export interface CockroachDbClusterProps {
  /** Cluster name — used in metadata, labels, and service names. */
  name: string;
  /** Namespace for all namespaced resources. */
  namespace?: string;
  /** Number of StatefulSet replicas (default: 3). */
  replicas?: number;
  /** CockroachDB container image (default: "cockroachdb/cockroach:v24.3.0"). */
  image?: string;
  /** PVC storage size per node (default: "100Gi"). */
  storageSize?: string;
  /** StorageClass name for PVCs. */
  storageClassName?: string;
  /** CPU limit per pod (default: "2"). */
  cpuLimit?: string;
  /** Memory limit per pod (default: "8Gi"). */
  memoryLimit?: string;
  /** Fraction of container memory for CockroachDB cache (default: ".25"). */
  cachePercent?: string;
  /** Fraction of container memory for SQL temp storage (default: ".25"). */
  sqlMemoryPercent?: string;
  /** CockroachDB locality flag (e.g., "cloud=aws,region=us-east-1"). */
  locality?: string;
  /** All node DNS names for --join (cross-cloud cluster membership). */
  joinAddresses?: string[];
  /** Enable TLS via self-signed CA certs (default: true). */
  secure?: boolean;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
}

export interface CockroachDbClusterResult {
  serviceAccount: Record<string, unknown>;
  role: Record<string, unknown>;
  roleBinding: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
  /** Client-facing service (ClusterIP, ports 26257+8080). */
  publicService: Record<string, unknown>;
  /** Pod discovery service (headless, publishNotReadyAddresses). */
  headlessService: Record<string, unknown>;
  pdb: Record<string, unknown>;
  statefulSet: Record<string, unknown>;
  /** One-shot cockroach init job. */
  initJob: Record<string, unknown>;
  /** Generates self-signed CA + node certs, stores in Secrets. */
  certGenJob: Record<string, unknown>;
}

/**
 * Create a CockroachDbCluster composite — returns prop objects for a full
 * CockroachDB StatefulSet deployment including RBAC, Services, PDB, and Jobs.
 *
 * @example
 * ```ts
 * import { CockroachDbCluster } from "@intentius/chant-lexicon-k8s";
 *
 * const crdb = CockroachDbCluster({
 *   name: "cockroachdb",
 *   namespace: "crdb",
 *   replicas: 3,
 *   locality: "cloud=aws,region=us-east-1",
 *   joinAddresses: [
 *     "cockroachdb-0.cockroachdb.crdb.svc.cluster.local",
 *     "cockroachdb-1.cockroachdb.crdb.svc.cluster.local",
 *     "cockroachdb-2.cockroachdb.crdb.svc.cluster.local",
 *   ],
 * });
 * ```
 */
export function CockroachDbCluster(props: CockroachDbClusterProps): CockroachDbClusterResult {
  const {
    name,
    namespace,
    replicas = 3,
    image = "cockroachdb/cockroach:v24.3.0",
    storageSize = "100Gi",
    storageClassName,
    cpuLimit = "2",
    memoryLimit = "8Gi",
    cachePercent = ".25",
    sqlMemoryPercent = ".25",
    locality,
    joinAddresses = [],
    secure = true,
    labels: extraLabels = {},
  } = props;

  const saName = name;
  const certsDir = "/cockroach/cockroach-certs";
  const dataDir = "/cockroach/cockroach-data";

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // ── RBAC ─────────────────────────────────────────────────────────

  const serviceAccount: Record<string, unknown> = {
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
  };

  const role: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "patch"] },
    ],
  };

  const roleBinding: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name,
    },
    subjects: [
      { kind: "ServiceAccount", name: saName, ...(namespace && { namespace }) },
    ],
  };

  const clusterRole: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests"], verbs: ["get", "create", "watch"] },
    ],
  };

  const clusterRoleBinding: Record<string, unknown> = {
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name,
    },
    subjects: [
      { kind: "ServiceAccount", name: saName, ...(namespace && { namespace }) },
    ],
  };

  // ── Services ────────────────────────────────────────────────────

  const publicService: Record<string, unknown> = {
    metadata: {
      name: `${name}-public`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [
        { port: 26257, targetPort: 26257, protocol: "TCP", name: "grpc" },
        { port: 8080, targetPort: 8080, protocol: "TCP", name: "http" },
      ],
      type: "ClusterIP",
    },
  };

  const headlessService: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
      annotations: {
        "service.alpha.kubernetes.io/tolerate-unready-endpoints": "true",
      },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [
        { port: 26257, targetPort: 26257, protocol: "TCP", name: "grpc" },
        { port: 8080, targetPort: 8080, protocol: "TCP", name: "http" },
      ],
      clusterIP: "None",
      publishNotReadyAddresses: true,
    },
  };

  // ── PodDisruptionBudget ─────────────────────────────────────────

  const pdb: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
    },
    spec: {
      maxUnavailable: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
    },
  };

  // ── StatefulSet ─────────────────────────────────────────────────

  const cockroachArgs = [
    "start",
    `--logtostderr=WARNING`,
    `--certs-dir=${secure ? certsDir : ""}`,
    ...(secure ? [] : ["--insecure"]),
    `--advertise-host=$(hostname -f)`,
    `--http-addr=0.0.0.0`,
    `--cache=${cachePercent}`,
    `--max-sql-memory=${sqlMemoryPercent}`,
    ...(joinAddresses.length > 0 ? [`--join=${joinAddresses.join(",")}`] : []),
    ...(locality ? [`--locality=${locality}`] : []),
  ];

  const volumes: Record<string, unknown>[] = [];
  const volumeMounts: Record<string, unknown>[] = [
    { name: "datadir", mountPath: dataDir },
  ];

  if (secure) {
    volumes.push({ name: "certs", secret: { secretName: `${name}-node-certs`, defaultMode: 0o400 } });
    volumeMounts.push({ name: "certs", mountPath: certsDir });
  }

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [
      { containerPort: 26257, name: "grpc" },
      { containerPort: 8080, name: "http" },
    ],
    command: ["/cockroach/cockroach"],
    args: cockroachArgs,
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
      requests: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts,
    env: [
      { name: "COCKROACH_CHANNEL", value: "kubernetes-multiregion" },
    ],
    readinessProbe: {
      httpGet: { path: "/health?ready=1", port: 8080, ...(secure && { scheme: "HTTPS" }) },
      initialDelaySeconds: 10,
      periodSeconds: 5,
      failureThreshold: 2,
    },
    livenessProbe: {
      httpGet: { path: "/health", port: 8080, ...(secure && { scheme: "HTTPS" }) },
      initialDelaySeconds: 30,
      periodSeconds: 5,
    },
  };

  const statefulSet: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    spec: {
      serviceName: name,
      replicas,
      podManagementPolicy: "Parallel",
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          terminationGracePeriodSeconds: 60,
          containers: [container],
          ...(volumes.length > 0 && { volumes }),
          affinity: {
            podAntiAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [
                {
                  weight: 100,
                  podAffinityTerm: {
                    labelSelector: { matchLabels: { "app.kubernetes.io/name": name } },
                    topologyKey: "kubernetes.io/hostname",
                  },
                },
              ],
            },
          },
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "datadir" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(storageClassName && { storageClassName }),
            resources: { requests: { storage: storageSize } },
          },
        },
      ],
    },
  };

  // ── cert-gen Job ─────────────────────────────────────────────────

  // Generates self-signed CA and node certs, stores them in K8s Secrets.
  // Each node's cert includes the pod DNS names (pod-N.svc.namespace.svc.cluster.local).
  const nodeNames = Array.from({ length: replicas }, (_, i) => `${name}-${i}.${name}`);
  const nodeAddresses = namespace
    ? nodeNames.map((n) => `${n}.${namespace}.svc.cluster.local`)
    : nodeNames.map((n) => `${n}.default.svc.cluster.local`);

  const certGenScript = [
    "set -ex",
    "cd /cockroach",
    "cockroach cert create-ca --certs-dir=certs --ca-key=certs/ca.key",
    `cockroach cert create-node ${nodeAddresses.join(" ")} localhost 127.0.0.1 --certs-dir=certs --ca-key=certs/ca.key`,
    "cockroach cert create-client root --certs-dir=certs --ca-key=certs/ca.key",
  ].join(" && ");

  const certGenJob: Record<string, unknown> = {
    metadata: {
      name: `${name}-cert-gen`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "cert-gen" },
    },
    spec: {
      backoffLimit: 3,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          restartPolicy: "OnFailure",
          containers: [
            {
              name: "cert-gen",
              image,
              command: ["bash", "-c", certGenScript],
            },
          ],
        },
      },
    },
  };

  // ── init Job ────────────────────────────────────────────────────

  const initArgs = secure
    ? [`--certs-dir=${certsDir}`, `--host=${name}-0.${name}`]
    : ["--insecure", `--host=${name}-0.${name}`];

  const initVolumes: Record<string, unknown>[] = [];
  const initVolumeMounts: Record<string, unknown>[] = [];
  if (secure) {
    initVolumes.push({ name: "client-certs", secret: { secretName: `${name}-node-certs`, defaultMode: 0o400 } });
    initVolumeMounts.push({ name: "client-certs", mountPath: certsDir });
  }

  const initJob: Record<string, unknown> = {
    metadata: {
      name: `${name}-init`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "init" },
    },
    spec: {
      backoffLimit: 6,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          restartPolicy: "OnFailure",
          containers: [
            {
              name: "cluster-init",
              image,
              command: ["/cockroach/cockroach"],
              args: ["init", ...initArgs],
              ...(initVolumeMounts.length > 0 && { volumeMounts: initVolumeMounts }),
            },
          ],
          ...(initVolumes.length > 0 && { volumes: initVolumes }),
        },
      },
    },
  };

  return {
    serviceAccount,
    role,
    roleBinding,
    clusterRole,
    clusterRoleBinding,
    publicService,
    headlessService,
    pdb,
    statefulSet,
    initJob,
    certGenJob,
  };
}
