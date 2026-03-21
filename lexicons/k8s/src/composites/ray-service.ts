/**
 * RayService composite — KubeRay RayService CR + surrounding K8s infra.
 *
 * RayService manages a persistent Ray Serve HTTP endpoint with zero-downtime
 * blue-green upgrades. Ideal for online inference and serving workloads.
 *
 * Encodes the same production defaults as RayCluster (NetworkPolicy, preStop
 * hooks, PDB, optional shared PVC, optional autoscaler RBAC) plus a
 * LoadBalancer Service exposing the Serve HTTP endpoint on port 8000.
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
  RayService as RayServiceResource,
} from "../generated";
import {
  type RayClusterSpec,
  buildRayClusterParts,
  buildRayNetworkPolicy,
} from "./ray-cluster";

export type { RayClusterSpec };
export type { ResourceSpec, HeadGroupSpec, WorkerGroupSpec } from "./ray-cluster";

export interface RayServiceProps {
  name: string;
  namespace: string;
  /**
   * Ray Serve application config in YAML format.
   * Passed verbatim to spec.serveConfigV2.
   * See https://docs.ray.io/en/latest/serve/production-guide/config.html
   */
  serveConfigV2: string;
  cluster: RayClusterSpec;
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
    pdb?: Partial<Record<string, unknown>>;
    pvc?: Partial<Record<string, unknown>>;
    serveService?: Partial<Record<string, unknown>>;
    rayService?: Partial<Record<string, unknown>>;
  };
}

export interface RayServiceResult {
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole?: InstanceType<typeof ClusterRole>;
  clusterRoleBinding?: InstanceType<typeof ClusterRoleBinding>;
  networkPolicy: InstanceType<typeof NetworkPolicy>;
  pdb: InstanceType<typeof PodDisruptionBudget>;
  pvc?: InstanceType<typeof PersistentVolumeClaim>;
  /** LoadBalancer Service exposing Ray Serve on port 8000. */
  serveService: InstanceType<typeof Service>;
  rayService: InstanceType<typeof RayServiceResource>;
}

/**
 * Create a RayService composite — persistent Ray Serve endpoint with
 * zero-downtime blue-green upgrades.
 *
 * @example
 * ```ts
 * import { RayService } from "@intentius/chant-lexicon-k8s";
 *
 * const svc = RayService({
 *   name: "inference",
 *   namespace: "ray-system",
 *   serveConfigV2: `
 *     applications:
 *       - name: classifier
 *         import_path: app:deployment
 *         deployments:
 *           - name: Classifier
 *             num_replicas: 2
 *   `,
 *   cluster: {
 *     image: "us-docker.pkg.dev/my-project/ray-images/ray:2.40.0",
 *     head: { resources: { cpu: "2", memory: "8Gi" } },
 *     workerGroups: [
 *       { groupName: "gpu", replicas: 2,
 *         resources: { cpu: "4", memory: "16Gi", gpu: 1 },
 *         gpuTolerations: true },
 *     ],
 *   },
 * });
 * ```
 */
export const RayService = Composite<RayServiceProps>((props) => {
  const {
    name,
    namespace,
    serveConfigV2,
    cluster,
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
        resources: ["rayservices"],
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
  // RayService exposes port 8000 (Serve HTTP) externally via LoadBalancer,
  // so we allow ingress from outside the cluster on that port.

  const networkPolicy = buildRayNetworkPolicy(
    name, namespace, commonLabels, false, defs?.networkPolicy,
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

  // -- Ray Serve LoadBalancer Service --

  const serveService = new Service(mergeDefaults({
    metadata: {
      name: `${name}-serve`,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "serve" },
    },
    spec: {
      type: "LoadBalancer",
      selector: {
        "ray.io/cluster-name": name,
        "ray.io/node-type": "head",
      },
      ports: [{ port: 8000, targetPort: 8000, protocol: "TCP", name: "serve" }],
    },
  }, defs?.serveService));

  // -- RayService CR --

  const { headGroupSpec, workerGroupSpecs } = buildRayClusterParts(
    cluster, saName, spilloverBucket, pvcName, mountPath,
  );

  const rayService = new RayServiceResource(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: commonLabels,
    },
    spec: {
      serveConfigV2,
      rayClusterConfig: {
        ...(enableAutoscaler && { enableInTreeAutoscaling: true }),
        headGroupSpec,
        workerGroupSpecs,
      },
    },
  }, defs?.rayService));

  return {
    serviceAccount,
    ...(clusterRole && { clusterRole }),
    ...(clusterRoleBinding && { clusterRoleBinding }),
    networkPolicy,
    pdb,
    ...(pvc && { pvc }),
    serveService,
    rayService,
  };
}, "RayService");
