/**
 * RayCluster composite — KubeRay RayCluster CR + surrounding K8s infra.
 *
 * Encodes production defaults for running Ray on Kubernetes:
 * - NetworkPolicy with podSelector rules (avoids GKE pod CIDR mismatch)
 * - PodDisruptionBudget on the head (minAvailable: 1)
 * - preStop: ray stop hooks + terminationGracePeriodSeconds: 120 on all pods
 * - ServiceAccount for the head + optional autoscaler ClusterRole/CRB
 * - Optional shared ReadWriteMany PVC for training data (Filestore/EFS)
 * - Optional GCS spillover env var for object store spill-to-GCS
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  NetworkPolicy,
  PodDisruptionBudget,
  PersistentVolumeClaim,
  Service,
  RayCluster as RayClusterResource,
} from "../generated";

// ── Shared types (re-exported for RayJob and RayService) ────────────────────

/** Container resource spec for Ray pods. */
export interface ResourceSpec {
  /** CPU request/limit (e.g. "2", "500m"). */
  cpu: string;
  /** Memory request/limit (e.g. "4Gi", "512Mi"). */
  memory: string;
  /** GPU count — adds nvidia.com/gpu to resource requests and limits. */
  gpu?: number;
}

/** Head node configuration. */
export interface HeadGroupSpec {
  resources: ResourceSpec;
  /**
   * Shared memory size mounted at /dev/shm (default: "2Gi").
   * Prevents OOM when PyTorch workers share tensors via /dev/shm.
   */
  shmSize?: string;
  /** Additional Ray start params merged into defaults. */
  rayStartParams?: Record<string, string>;
  /** Additional environment variables for the head container. */
  env?: Array<{ name: string; value: string }>;
}

/** Worker group configuration. */
export interface WorkerGroupSpec {
  /** Worker group name — used as a selector label (e.g. "cpu", "gpu"). */
  groupName: string;
  /** Initial replica count. */
  replicas: number;
  /** Minimum replicas for autoscaling (default: replicas). */
  minReplicas?: number;
  /** Maximum replicas for autoscaling (default: replicas). */
  maxReplicas?: number;
  resources: ResourceSpec;
  /**
   * Idle timeout before the Ray autoscaler terminates idle workers (default: 60s).
   * Use 300s for GPU groups to amortize initialization overhead.
   */
  idleTimeoutSeconds?: number;
  /** Add nvidia.com/gpu NoSchedule toleration — required for GPU tainted node pools. */
  gpuTolerations?: boolean;
  /** Additional Ray start params. num-cpus is derived from resources.cpu automatically. */
  rayStartParams?: Record<string, string>;
  /** Additional environment variables for worker containers. */
  env?: Array<{ name: string; value: string }>;
}

/** Cluster spec shared by RayCluster, RayJob, and RayService. */
export interface RayClusterSpec {
  /**
   * Container image for head and all worker groups.
   * Use a pre-built image stored in Artifact Registry / ECR for production —
   * pip installs via runtimeEnv add minutes to cold start at scale.
   */
  image: string;
  head: HeadGroupSpec;
  workerGroups: WorkerGroupSpec[];
}

// ── RayCluster composite props ───────────────────────────────────────────────

export interface RayClusterProps {
  name: string;
  namespace: string;
  cluster: RayClusterSpec;
  /**
   * Shared ReadWriteMany storage for training data.
   * Mounts the same PVC into head and all worker pods.
   * Use Filestore ENTERPRISE (GKE) or EFS (AWS) for production SLA.
   */
  sharedStorage?: {
    storageClass: string;
    size: string;
    /** Mount path in all containers (default: "/mnt/ray-data"). */
    mountPath?: string;
  };
  /**
   * Enable Ray in-tree autoscaler.
   * Creates a ClusterRole/CRB granting pod CRUD to the head ServiceAccount.
   */
  enableAutoscaler?: boolean;
  /**
   * GCS bucket name for object store spill-to-GCS.
   * Injects RAY_object_spilling_config into the head container.
   * Without this, large object graphs (model weights) cause OOM on the head.
   */
  spilloverBucket?: string;
  /**
   * Emit a LoadBalancer Service exposing the Ray dashboard on port 8265.
   * Default false — use `kubectl port-forward svc/<name>-head-svc 8265:8265`.
   */
  exposeDashboard?: boolean;
  /** Additional labels applied to all resources. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides via mergeDefaults. */
  defaults?: {
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    networkPolicy?: Partial<Record<string, unknown>>;
    pdb?: Partial<Record<string, unknown>>;
    pvc?: Partial<Record<string, unknown>>;
    dashboardService?: Partial<Record<string, unknown>>;
    rayCluster?: Partial<Record<string, unknown>>;
  };
}

export interface RayClusterResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole?: InstanceType<typeof ClusterRole>;
  clusterRoleBinding?: InstanceType<typeof ClusterRoleBinding>;
  networkPolicy: InstanceType<typeof NetworkPolicy>;
  pdb: InstanceType<typeof PodDisruptionBudget>;
  pvc?: InstanceType<typeof PersistentVolumeClaim>;
  /** Only present when exposeDashboard is true. */
  dashboardService?: InstanceType<typeof Service>;
  rayCluster: InstanceType<typeof RayClusterResource>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Parse a CPU string to a numeric count for --num-cpus. "2" → "2", "500m" → "0.5". */
function cpuToNumCpus(cpu: string): string {
  if (cpu.endsWith("m")) {
    const millis = parseInt(cpu.slice(0, -1), 10);
    return String(millis / 1000);
  }
  return cpu;
}

/** Build resource requests/limits. GPU count maps to nvidia.com/gpu. */
function buildResources(spec: ResourceSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { cpu: spec.cpu, memory: spec.memory };
  if (spec.gpu) base["nvidia.com/gpu"] = String(spec.gpu);
  return { requests: { ...base }, limits: { ...base } };
}

/** Shared volume list for a pod (dshm + optional PVC). */
function buildPodVolumes(
  shmSize: string,
  pvcName?: string,
): Array<Record<string, unknown>> {
  const vols: Array<Record<string, unknown>> = [
    { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: shmSize } },
  ];
  if (pvcName) {
    vols.push({ name: "shared-data", persistentVolumeClaim: { claimName: pvcName } });
  }
  return vols;
}

/** Shared volume mounts for a container (dshm + optional shared-data). */
function buildVolumeMounts(mountPath?: string): Array<Record<string, unknown>> {
  const mounts: Array<Record<string, unknown>> = [
    { name: "dshm", mountPath: "/dev/shm" },
  ];
  if (mountPath) {
    mounts.push({ name: "shared-data", mountPath });
  }
  return mounts;
}

// ── Shared cluster spec builder (used by RayJob and RayService too) ──────────

/**
 * Build headGroupSpec and workerGroupSpecs for a KubeRay CR.
 * Exported for use in RayJob and RayService composites.
 */
export function buildRayClusterParts(
  cluster: RayClusterSpec,
  saName: string,
  spilloverBucket: string | undefined,
  pvcName: string | undefined,
  mountPath: string | undefined,
): { headGroupSpec: Record<string, unknown>; workerGroupSpecs: Array<Record<string, unknown>> } {
  const { image, head, workerGroups } = cluster;
  const shmSize = head.shmSize ?? "2Gi";
  const resolvedMountPath = pvcName ? (mountPath ?? "/mnt/ray-data") : undefined;

  // ── Head container ─────────────────────────────────────────────────────
  const headEnv: Array<Record<string, unknown>> = [...(head.env ?? [])];
  if (spilloverBucket) {
    headEnv.push({
      name: "RAY_object_spilling_config",
      value: JSON.stringify({
        type: "smart_open",
        params: { uri: `gs://${spilloverBucket}/spill` },
      }),
    });
  }

  const headContainer: Record<string, unknown> = {
    name: "ray-head",
    image,
    resources: buildResources(head.resources),
    ports: [
      { containerPort: 6379, name: "gcs-server" },
      { containerPort: 8265, name: "dashboard" },
      { containerPort: 10001, name: "client" },
      { containerPort: 8080, name: "metrics" },
    ],
    ...(headEnv.length > 0 && { env: headEnv }),
    volumeMounts: buildVolumeMounts(resolvedMountPath),
    lifecycle: { preStop: { exec: { command: ["ray", "stop"] } } },
  };

  const headGroupSpec: Record<string, unknown> = {
    rayStartParams: { ...(head.rayStartParams ?? {}) },
    template: {
      spec: {
        serviceAccountName: saName,
        terminationGracePeriodSeconds: 120,
        containers: [headContainer],
        volumes: buildPodVolumes(shmSize, pvcName),
      },
    },
  };

  // ── Worker groups ───────────────────────────────────────────────────────
  const workerGroupSpecs = workerGroups.map((group) => {
    const workerContainer: Record<string, unknown> = {
      name: "ray-worker",
      image,
      resources: buildResources(group.resources),
      ...(group.env && group.env.length > 0 && { env: group.env }),
      volumeMounts: buildVolumeMounts(resolvedMountPath),
      lifecycle: { preStop: { exec: { command: ["ray", "stop"] } } },
    };

    const rayStartParams: Record<string, string> = {
      "num-cpus": cpuToNumCpus(group.resources.cpu),
      ...(group.resources.gpu ? { "num-gpus": String(group.resources.gpu) } : {}),
      ...(group.rayStartParams ?? {}),
    };

    const podSpec: Record<string, unknown> = {
      terminationGracePeriodSeconds: 120,
      containers: [workerContainer],
      volumes: buildPodVolumes("2Gi", pvcName),
    };

    if (group.gpuTolerations) {
      podSpec.tolerations = [
        { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" },
      ];
    }

    return {
      groupName: group.groupName,
      replicas: group.replicas,
      minReplicas: group.minReplicas ?? group.replicas,
      maxReplicas: group.maxReplicas ?? group.replicas,
      idleTimeoutSeconds: group.idleTimeoutSeconds ?? 60,
      rayStartParams,
      template: { spec: podSpec },
    };
  });

  return { headGroupSpec, workerGroupSpecs };
}

// ── NetworkPolicy builder ─────────────────────────────────────────────────────

/**
 * Build a NetworkPolicy for a Ray cluster.
 * Uses podSelector-only rules for intra-cluster traffic to avoid GKE pod CIDR
 * mismatch (GKE secondary pod CIDRs differ from declared subnet CIDRs).
 * GCS egress uses ipBlock excluding RFC1918 to allow Google APIs while
 * blocking internal lateral movement.
 */
export function buildRayNetworkPolicy(
  name: string,
  namespace: string,
  commonLabels: Record<string, string>,
  exposeDashboard: boolean,
  defOverride: Partial<Record<string, unknown>> | undefined,
): InstanceType<typeof NetworkPolicy> {
  const clusterSelector = { matchLabels: { "ray.io/cluster-name": name } };

  const rayPorts = [
    { port: 6379, protocol: "TCP" },
    { port: 10001, protocol: "TCP" },
    { port: 10002, protocol: "TCP" },
    { port: 8080, protocol: "TCP" },
    // Ephemeral gRPC ports for worker-to-worker communication (requires K8s 1.25+)
    { port: 32768, endPort: 60999, protocol: "TCP" },
  ];

  const ingressRules: Array<Record<string, unknown>> = [
    {
      from: [{ podSelector: clusterSelector }],
      ports: [...rayPorts, { port: 8265, protocol: "TCP" }],
    },
  ];

  // When the dashboard is externally exposed, allow ingress from outside the cluster
  if (exposeDashboard) {
    ingressRules.push({ ports: [{ port: 8265, protocol: "TCP" }] });
  }

  const egressRules: Array<Record<string, unknown>> = [
    // Intra-cluster Ray traffic
    {
      to: [{ podSelector: clusterSelector }],
      ports: [...rayPorts, { port: 8265, protocol: "TCP" }],
    },
    // DNS — required for head service name resolution
    {
      ports: [
        { port: 53, protocol: "UDP" },
        { port: 53, protocol: "TCP" },
      ],
    },
    // GCS / Artifact Registry HTTPS — ipBlock excludes RFC1918 to prevent
    // lateral movement while allowing Google API endpoints
    {
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
          },
        },
      ],
      ports: [{ port: 443, protocol: "TCP" }],
    },
  ];

  return new NetworkPolicy(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "network-policy" },
    },
    spec: {
      podSelector: clusterSelector,
      policyTypes: ["Ingress", "Egress"],
      ingress: ingressRules,
      egress: egressRules,
    },
  }, defOverride));
}

// ── Composite ────────────────────────────────────────────────────────────────

/**
 * Create a RayCluster composite — returns a KubeRay RayCluster CR and the
 * surrounding K8s resources needed for a production Ray cluster.
 *
 * @example
 * ```ts
 * import { RayCluster } from "@intentius/chant-lexicon-k8s";
 *
 * const ray = RayCluster({
 *   name: "ray",
 *   namespace: "ray-system",
 *   cluster: {
 *     image: "us-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
 *     head: { resources: { cpu: "2", memory: "8Gi" } },
 *     workerGroups: [
 *       { groupName: "cpu", replicas: 2, minReplicas: 1, maxReplicas: 8,
 *         resources: { cpu: "2", memory: "4Gi" } },
 *     ],
 *   },
 *   enableAutoscaler: true,
 *   spilloverBucket: "my-ray-spill",
 * });
 * ```
 */
export const RayCluster = Composite<RayClusterProps>((props) => {
  const {
    name,
    namespace,
    cluster,
    sharedStorage,
    enableAutoscaler = false,
    spilloverBucket,
    exposeDashboard = false,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const saName = `${name}-head`;
  const pvcName = sharedStorage ? `${name}-shared` : undefined;
  const mountPath = sharedStorage?.mountPath;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/component": "ray",
    ...extraLabels,
  };

  // -- ServiceAccount --

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "service-account" },
    },
  }, defs?.serviceAccount));

  // -- Autoscaler RBAC (optional) --

  const clusterRole = enableAutoscaler ? new ClusterRole(mergeDefaults({
    metadata: {
      name: `${name}-autoscaler`,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["get", "list", "watch", "create", "delete", "patch"],
      },
      {
        apiGroups: [""],
        resources: ["pods/status"],
        verbs: ["get"],
      },
      {
        apiGroups: ["ray.io"],
        resources: ["rayclusters"],
        verbs: ["get", "list", "patch"],
      },
    ],
  }, defs?.clusterRole)) : undefined;

  const clusterRoleBinding = enableAutoscaler ? new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: `${name}-autoscaler`,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: `${name}-autoscaler`,
    },
    subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
  }, defs?.clusterRoleBinding)) : undefined;

  // -- NetworkPolicy --

  const networkPolicy = buildRayNetworkPolicy(
    name, namespace, commonLabels, exposeDashboard, defs?.networkPolicy,
  );

  // -- PodDisruptionBudget (head) --

  const pdb = new PodDisruptionBudget(mergeDefaults({
    metadata: {
      name: `${name}-head`,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
    },
    spec: {
      minAvailable: 1,
      selector: {
        matchLabels: {
          "ray.io/cluster-name": name,
          "ray.io/node-type": "head",
        },
      },
    },
  }, defs?.pdb));

  // -- Shared PVC (optional) --

  const pvc = sharedStorage ? new PersistentVolumeClaim(mergeDefaults({
    metadata: {
      name: pvcName!,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "storage" },
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: sharedStorage.storageClass,
      resources: { requests: { storage: sharedStorage.size } },
    },
  }, defs?.pvc)) : undefined;

  // -- Dashboard LoadBalancer Service (optional) --

  const dashboardService = exposeDashboard ? new Service(mergeDefaults({
    metadata: {
      name: `${name}-dashboard`,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "dashboard" },
    },
    spec: {
      type: "LoadBalancer",
      selector: {
        "ray.io/cluster-name": name,
        "ray.io/node-type": "head",
      },
      ports: [{ port: 8265, targetPort: 8265, protocol: "TCP", name: "dashboard" }],
    },
  }, defs?.dashboardService)) : undefined;

  // -- RayCluster CR --

  const { headGroupSpec, workerGroupSpecs } = buildRayClusterParts(
    cluster, saName, spilloverBucket, pvcName, mountPath,
  );

  const rayCluster = new RayClusterResource(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: commonLabels,
    },
    spec: {
      ...(enableAutoscaler && { enableInTreeAutoscaling: true }),
      headGroupSpec,
      workerGroupSpecs,
    },
  }, defs?.rayCluster));

  return {
    serviceAccount,
    ...(clusterRole && { clusterRole }),
    ...(clusterRoleBinding && { clusterRoleBinding }),
    networkPolicy,
    pdb,
    ...(pvc && { pvc }),
    ...(dashboardService && { dashboardService }),
    rayCluster,
  };
}, "RayCluster");
