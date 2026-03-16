/**
 * CockroachDbCluster composite — StatefulSet + Services + RBAC + PDB + Jobs.
 *
 * Deploys a CockroachDB cluster on Kubernetes with TLS support via self-signed
 * certificates. Produces all K8s resources needed for a single cloud's slice of
 * a CockroachDB cluster (typically 3 nodes). Multi-cloud deployments use one
 * CockroachDbCluster per cloud, sharing joinAddresses across clouds.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { StatefulSet, Service, ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding, PodDisruptionBudget, Job } from "../generated";

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
  /**
   * Skip the cockroach init Job (default: false).
   * Set true for secondary regions in a multi-region cluster — only ONE region
   * should run `cockroach init` to bootstrap the unified cluster. Secondary
   * nodes start fresh and auto-join the cluster via the joinAddresses.
   */
  skipInit?: boolean;
  /**
   * Skip the cert-gen Job (default: false).
   * Set true for multi-region deployments where a shared CA and node certs are
   * pre-generated externally (e.g. via generate-certs.sh) and distributed via
   * External Secrets Operator or direct kubectl. Each region's cert-gen creates
   * a separate CA, breaking cross-region TLS — so all regions must use the same CA.
   */
  skipCertGen?: boolean;
  /**
   * Extra DNS names / IPs to include in node cert SANs beyond the auto-generated
   * cluster-local names. Use for cross-region or external hostnames.
   * E.g. ["cockroachdb-0.east.crdb.internal", "cockroachdb-1.east.crdb.internal"].
   */
  extraCertNodeAddresses?: string[];
  /**
   * Domain suffix for cross-cluster advertise address (e.g. "east.crdb.internal").
   * When set, nodes advertise "${HOSTNAME}.${advertiseHostDomain}" instead of the
   * cluster-local FQDN from $(hostname -f). Required for multi-region clusters so
   * that gossip addresses are resolvable from other Kubernetes clusters.
   * E.g. pod "cockroachdb-0" in east advertises "cockroachdb-0.east.crdb.internal".
   */
  advertiseHostDomain?: string;
  /**
   * Mount the client certs secret (`${name}-client-certs`) into pods at
   * `/cockroach/cockroach-client-certs` (default: false).
   *
   * Enable for multi-region deployments where `cockroach init`, `cockroach sql`,
   * and backup schedule setup run inside a pod via `kubectl exec`. The client cert
   * is separate from the node cert and is NOT included in the node certs secret.
   * Without this flag you must inject client certs manually (e.g. via /tmp).
   */
  mountClientCerts?: boolean;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    publicService?: Partial<Record<string, unknown>>;
    headlessService?: Partial<Record<string, unknown>>;
    pdb?: Partial<Record<string, unknown>>;
    statefulSet?: Partial<Record<string, unknown>>;
    initJob?: Partial<Record<string, unknown>>;
    certGenJob?: Partial<Record<string, unknown>>;
  };
}

export interface CockroachDbClusterResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  role: InstanceType<typeof Role>;
  roleBinding: InstanceType<typeof RoleBinding>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  /** Client-facing service (ClusterIP, ports 26257+8080). */
  publicService: InstanceType<typeof Service>;
  /** Pod discovery service (headless, publishNotReadyAddresses). */
  headlessService: InstanceType<typeof Service>;
  pdb: InstanceType<typeof PodDisruptionBudget>;
  statefulSet: InstanceType<typeof StatefulSet>;
  /** One-shot cockroach init job. Absent when skipInit is true. */
  initJob?: InstanceType<typeof Job>;
  /** Generates self-signed CA + node certs, stores in Secrets. Absent when skipCertGen is true. */
  certGenJob?: InstanceType<typeof Job>;
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
export const CockroachDbCluster = Composite<CockroachDbClusterProps>((props) => {
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
    skipInit = false,
    skipCertGen = false,
    extraCertNodeAddresses = [],
    advertiseHostDomain,
    mountClientCerts = false,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const saName = name;
  const certsDir = "/cockroach/cockroach-certs";
  const clientCertsDir = "/cockroach/cockroach-client-certs";
  const dataDir = "/cockroach/cockroach-data";

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // -- RBAC --

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
  }, defs?.serviceAccount));

  const role = new Role(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "patch"] },
    ],
  }, defs?.role));

  const roleBinding = new RoleBinding(mergeDefaults({
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
  }, defs?.roleBinding));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests"], verbs: ["get", "create", "watch"] },
    ],
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
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
  }, defs?.clusterRoleBinding));

  // -- Services --

  const publicService = new Service(mergeDefaults({
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
  }, defs?.publicService));

  const headlessService = new Service(mergeDefaults({
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
  }, defs?.headlessService));

  // -- PodDisruptionBudget --

  const pdb = new PodDisruptionBudget(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
    },
    spec: {
      maxUnavailable: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
    },
  }, defs?.pdb));

  // -- StatefulSet --

  // Build the cockroach start command as a shell string so that $(hostname -f)
  // is expanded at runtime. K8s exec-form args do NOT invoke a shell, so
  // $(...) substitutions are never evaluated unless we wrap with sh -c.
  // When advertiseHostDomain is set, advertise the cross-cluster ExternalDNS name
  // (e.g. "cockroachdb-0.east.crdb.internal") so gossip addresses are resolvable
  // from other Kubernetes clusters. Otherwise fall back to the cluster-local FQDN.
  const advertiseHostFlag = advertiseHostDomain
    ? `--advertise-host=\${HOSTNAME}.${advertiseHostDomain}`
    : `--advertise-host=$(hostname -f)`;

  const cockroachFlags = [
    `--logtostderr=WARNING`,
    ...(secure ? [`--certs-dir=${certsDir}`] : ["--insecure"]),
    advertiseHostFlag,
    `--http-addr=0.0.0.0`,
    `--cache=${cachePercent}`,
    `--max-sql-memory=${sqlMemoryPercent}`,
    ...(joinAddresses.length > 0 ? [`--join=${joinAddresses.join(",")}`] : []),
    ...(locality ? [`--locality=${locality}`] : []),
  ];
  const cockroachStartCmd = `/cockroach/cockroach start ${cockroachFlags.join(" ")}`;

  const volumes: Record<string, unknown>[] = [];
  const volumeMounts: Record<string, unknown>[] = [
    { name: "datadir", mountPath: dataDir },
  ];

  if (secure) {
    volumes.push({ name: "certs", secret: { secretName: `${name}-node-certs`, defaultMode: 0o400 } });
    volumeMounts.push({ name: "certs", mountPath: certsDir });
    if (mountClientCerts) {
      volumes.push({ name: "client-certs", secret: { secretName: `${name}-client-certs`, defaultMode: 0o400 } });
      volumeMounts.push({ name: "client-certs", mountPath: clientCertsDir });
    }
  }

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [
      { containerPort: 26257, name: "grpc" },
      { containerPort: 8080, name: "http" },
    ],
    command: ["/bin/sh", "-c"],
    args: [cockroachStartCmd],
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

  const statefulSet = new StatefulSet(mergeDefaults({
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
  }, defs?.statefulSet));

  // -- cert-gen Job --

  // Generates self-signed CA and node certs, stores them in K8s Secrets.
  // Each node's cert includes the pod DNS names (pod-N.svc.namespace.svc.cluster.local).
  // NOTE: The cert-gen Job uses `curl` to create K8s Secrets via the API server.
  // CockroachDB UBI images (v24+) include curl. For multi-region deployments,
  // use an external cert generation script instead (see generate-certs.sh).
  const nodeNames = Array.from({ length: replicas }, (_, i) => `${name}-${i}.${name}`);
  // Include both short names (for in-cluster init job) and FQDNs (for cross-namespace/init connections).
  const nodeAddresses = namespace
    ? [...nodeNames, ...nodeNames.map((n) => `${n}.${namespace}.svc.cluster.local`)]
    : [...nodeNames, ...nodeNames.map((n) => `${n}.default.svc.cluster.local`)];

  const ns = namespace ?? "default";
  const nodeSecretName = `${name}-node-certs`;
  const clientSecretName = `${name}-client-certs`;

  const allCertNodeAddresses = [...nodeAddresses, ...extraCertNodeAddresses];

  const certGenScript = [
    "set -ex",
    "cd /cockroach",
    "cockroach cert create-ca --certs-dir=certs --ca-key=certs/ca.key",
    `cockroach cert create-node ${allCertNodeAddresses.join(" ")} localhost 127.0.0.1 --certs-dir=certs --ca-key=certs/ca.key`,
    "cockroach cert create-client root --certs-dir=certs --ca-key=certs/ca.key",
    // Store certs in K8s Secrets via the API using the ServiceAccount token.
    `TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)`,
    `K8S_CA=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`,
    `API=https://kubernetes.default.svc`,
    `NS=${ns}`,
    `encode() { base64 | tr -d '\\n'; }`,
    // Build JSON payloads for the two secrets.
    `NODE_PAYLOAD=$(printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"${nodeSecretName}","namespace":"%s"},"type":"Opaque","data":{"ca.crt":"%s","node.crt":"%s","node.key":"%s"}}' "$NS" "$(cat certs/ca.crt | encode)" "$(cat certs/node.crt | encode)" "$(cat certs/node.key | encode)")`,
    `CLIENT_PAYLOAD=$(printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"${clientSecretName}","namespace":"%s"},"type":"Opaque","data":{"ca.crt":"%s","client.root.crt":"%s","client.root.key":"%s"}}' "$NS" "$(cat certs/ca.crt | encode)" "$(cat certs/client.root.crt | encode)" "$(cat certs/client.root.key | encode)")`,
    // Create or update each secret.
    `for SECRET_INFO in "${nodeSecretName}:$NODE_PAYLOAD" "${clientSecretName}:$CLIENT_PAYLOAD"; do`,
    `  SECRET_NAME=\${SECRET_INFO%%:*}`,
    `  PAYLOAD=\${SECRET_INFO#*:}`,
    `  STATUS=$(curl -s --cacert $K8S_CA -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}' $API/api/v1/namespaces/$NS/secrets/$SECRET_NAME)`,
    `  if [ "$STATUS" = "200" ]; then`,
    `    curl -sf --cacert $K8S_CA -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X PUT $API/api/v1/namespaces/$NS/secrets/$SECRET_NAME -d "$PAYLOAD"`,
    `  else`,
    `    curl -sf --cacert $K8S_CA -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST $API/api/v1/namespaces/$NS/secrets -d "$PAYLOAD"`,
    `  fi`,
    `done`,
  ].join("\n");

  const certGenJob = skipCertGen ? undefined : new Job(mergeDefaults({
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
  }, defs?.certGenJob));

  // -- init Job (only when skipCertGen is false) --

  const initArgs = secure
    ? [`--certs-dir=${certsDir}`, `--host=${name}-0.${name}`]
    : ["--insecure", `--host=${name}-0.${name}`];

  const initVolumes: Record<string, unknown>[] = [];
  const initVolumeMounts: Record<string, unknown>[] = [];
  if (secure) {
    initVolumes.push({ name: "client-certs", secret: { secretName: `${name}-client-certs`, defaultMode: 0o400 } });
    initVolumeMounts.push({ name: "client-certs", mountPath: certsDir });
  }

  const initJob = skipInit ? undefined : new Job(mergeDefaults({
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
  }, defs?.initJob));

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
    ...(initJob && { initJob }),
    ...(certGenJob && { certGenJob }),
  };
}, "CockroachDbCluster");
