/**
 * RayJob composite — KubeRay RayJob CR + surrounding K8s infra.
 *
 * RayJob spins up an ephemeral Ray cluster, runs a single entrypoint command,
 * then tears the cluster down. Ideal for batch training pipelines.
 *
 * Encodes the same production defaults as RayCluster (NetworkPolicy,
 * preStop hooks, optional shared PVC, optional autoscaler RBAC).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  NetworkPolicy,
  PersistentVolumeClaim,
  RayJob as RayJobResource,
} from "../generated";
import {
  type RayClusterSpec,
  buildRayClusterParts,
  buildRayNetworkPolicy,
} from "./ray-cluster";

export type { RayClusterSpec };
export type { ResourceSpec, HeadGroupSpec, WorkerGroupSpec } from "./ray-cluster";

export interface RayJobProps {
  name: string;
  namespace: string;
  /**
   * Entrypoint command to run on the Ray cluster.
   * E.g. "python train.py --epochs 10"
   */
  entrypoint: string;
  cluster: RayClusterSpec;
  /**
   * Ray runtime environment YAML string.
   * Prefer pre-built images over pip installs here — each pip install adds
   * startup latency per worker on cold start.
   */
  runtimeEnvYAML?: string;
  /**
   * Tear down the cluster after the job finishes (default: true).
   * Set false to keep the cluster alive for debugging.
   */
  shutdownAfterJobFinishes?: boolean;
  /**
   * TTL in seconds before a finished RayJob is garbage-collected (default: 300).
   */
  ttlSecondsAfterFinished?: number;
  sharedStorage?: {
    storageClass: string;
    size: string;
    mountPath?: string;
  };
  enableAutoscaler?: boolean;
  spilloverBucket?: string;
  labels?: Record<string, string>;
  defaults?: {
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    networkPolicy?: Partial<Record<string, unknown>>;
    pvc?: Partial<Record<string, unknown>>;
    rayJob?: Partial<Record<string, unknown>>;
  };
}

export interface RayJobResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole?: InstanceType<typeof ClusterRole>;
  clusterRoleBinding?: InstanceType<typeof ClusterRoleBinding>;
  networkPolicy: InstanceType<typeof NetworkPolicy>;
  pvc?: InstanceType<typeof PersistentVolumeClaim>;
  rayJob: InstanceType<typeof RayJobResource>;
}

/**
 * Create a RayJob composite — ephemeral Ray cluster for a single batch job.
 *
 * @example
 * ```ts
 * import { RayJob } from "@intentius/chant-lexicon-k8s";
 *
 * const job = RayJob({
 *   name: "train-resnet",
 *   namespace: "ray-system",
 *   entrypoint: "python train.py --epochs 50",
 *   cluster: {
 *     image: "us-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
 *     head: { resources: { cpu: "2", memory: "8Gi" } },
 *     workerGroups: [
 *       { groupName: "gpu", replicas: 4,
 *         resources: { cpu: "8", memory: "32Gi", gpu: 1 },
 *         gpuTolerations: true },
 *     ],
 *   },
 *   spilloverBucket: "my-ray-spill",
 * });
 * ```
 */
export const RayJob = Composite<RayJobProps>((props) => {
  const {
    name,
    namespace,
    entrypoint,
    cluster,
    runtimeEnvYAML,
    shutdownAfterJobFinishes = true,
    ttlSecondsAfterFinished = 300,
    sharedStorage,
    enableAutoscaler = false,
    spilloverBucket,
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
        resources: ["rayjobs"],
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
    name, namespace, commonLabels, false, defs?.networkPolicy,
  );

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

  // -- RayJob CR --

  const { headGroupSpec, workerGroupSpecs } = buildRayClusterParts(
    cluster, saName, spilloverBucket, pvcName, mountPath,
  );

  const rayJob = new RayJobResource(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: commonLabels,
    },
    spec: {
      entrypoint,
      ...(runtimeEnvYAML && { runtimeEnvYAML }),
      shutdownAfterJobFinishes,
      ttlSecondsAfterFinished,
      rayClusterSpec: {
        ...(enableAutoscaler && { enableInTreeAutoscaling: true }),
        headGroupSpec,
        workerGroupSpecs,
      },
    },
  }, defs?.rayJob));

  return {
    serviceAccount,
    ...(clusterRole && { clusterRole }),
    ...(clusterRoleBinding && { clusterRoleBinding }),
    networkPolicy,
    ...(pvc && { pvc }),
    rayJob,
  };
}, "RayJob");
