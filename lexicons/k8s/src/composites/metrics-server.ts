/**
 * MetricsServer composite — Deployment + Service + ServiceAccount + RBAC + APIService.
 *
 * Deploys metrics-server for HPA pod CPU/memory metrics. metrics-server is not an
 * EKS managed addon — it needs K8s workloads. Uses in-cluster RBAC only (no IRSA).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service, ServiceAccount, ClusterRole, ClusterRoleBinding, APIService } from "../generated";

export interface MetricsServerProps {
  /** Agent name (default: "metrics-server"). */
  name?: string;
  /** Container image (default: "registry.k8s.io/metrics-server/metrics-server:v0.7.2"). */
  image?: string;
  /** Replicas (default: 1). */
  replicas?: number;
  /** Namespace (default: "kube-system"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    aggregatedClusterRole?: Partial<Record<string, unknown>>;
    authDelegatorBinding?: Partial<Record<string, unknown>>;
    apiService?: Partial<Record<string, unknown>>;
  };
}

export interface MetricsServerResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  /** ClusterRole for aggregated API access. */
  aggregatedClusterRole: InstanceType<typeof ClusterRole>;
  /** Binding for aggregated API auth-delegator. */
  authDelegatorBinding: InstanceType<typeof ClusterRoleBinding>;
  /** APIService registration for v1beta1.metrics.k8s.io. */
  apiService: InstanceType<typeof APIService>;
}

/**
 * Create a MetricsServer composite — returns prop objects for a Deployment,
 * Service, ServiceAccount, ClusterRoles, ClusterRoleBindings, and APIService.
 *
 * @example
 * ```ts
 * import { MetricsServer } from "@intentius/chant-lexicon-k8s";
 *
 * const ms = MetricsServer({});
 * ```
 */
export const MetricsServer = Composite<MetricsServerProps>((props) => {
  const {
    name = "metrics-server",
    image = "registry.k8s.io/metrics-server/metrics-server:v0.7.2",
    replicas = 1,
    namespace = "kube-system",
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const saName = `${name}-sa`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const deployment = new Deployment(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "metrics" },
    },
    spec: {
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [
            {
              name,
              image,
              args: [
                "--cert-dir=/tmp",
                "--secure-port=10250",
                "--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname",
                "--kubelet-use-node-status-port",
                "--metric-resolution=15s",
              ],
              ports: [{ containerPort: 10250, name: "https", protocol: "TCP" }],
              resources: {
                requests: { cpu: "100m", memory: "200Mi" },
                limits: { cpu: "100m", memory: "200Mi" },
              },
              livenessProbe: {
                httpGet: { path: "/livez", port: 10250, scheme: "HTTPS" },
                initialDelaySeconds: 0,
                periodSeconds: 10,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: "/readyz", port: 10250, scheme: "HTTPS" },
                initialDelaySeconds: 20,
                periodSeconds: 10,
                failureThreshold: 3,
              },
              securityContext: {
                runAsNonRoot: true,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
              },
              volumeMounts: [{ name: "tmp-dir", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp-dir", emptyDir: {} }],
          priorityClassName: "system-cluster-critical",
        },
      },
    },
  }, defs?.deployment));

  const service = new Service(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: {
        ...commonLabels,
        "app.kubernetes.io/component": "metrics",
        "kubernetes.io/cluster-service": "true",
        "kubernetes.io/name": "Metrics-server",
      },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ port: 443, targetPort: 10250, protocol: "TCP", name: "https" }],
    },
  }, defs?.service));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "metrics" },
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: `system:${name}`,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["pods", "nodes", "namespaces", "configmaps"], verbs: ["get", "list", "watch"] },
      { apiGroups: [""], resources: ["nodes/metrics", "nodes/stats"], verbs: ["get"] },
    ],
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: `system:${name}`,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: `system:${name}`,
    },
    subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
  }, defs?.clusterRoleBinding));

  const aggregatedClusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: `system:${name}-aggregated-reader`,
      labels: {
        ...commonLabels,
        "app.kubernetes.io/component": "rbac",
        "rbac.authorization.k8s.io/aggregate-to-admin": "true",
        "rbac.authorization.k8s.io/aggregate-to-edit": "true",
        "rbac.authorization.k8s.io/aggregate-to-view": "true",
      },
    },
    rules: [
      { apiGroups: ["metrics.k8s.io"], resources: ["pods", "nodes"], verbs: ["get", "list", "watch"] },
    ],
  }, defs?.aggregatedClusterRole));

  const authDelegatorBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: `${name}:system:auth-delegator`,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "system:auth-delegator",
    },
    subjects: [{ kind: "ServiceAccount", name: saName, namespace }],
  }, defs?.authDelegatorBinding));

  const apiService = new APIService(mergeDefaults({
    apiVersion: "apiregistration.k8s.io/v1",
    kind: "APIService",
    metadata: {
      name: "v1beta1.metrics.k8s.io",
      labels: { ...commonLabels, "app.kubernetes.io/component": "metrics" },
    },
    spec: {
      service: { name, namespace },
      group: "metrics.k8s.io",
      version: "v1beta1",
      insecureSkipTLSVerify: true,
      groupPriorityMinimum: 100,
      versionPriority: 100,
    },
  }, defs?.apiService));

  return {
    deployment,
    service,
    serviceAccount,
    clusterRole,
    clusterRoleBinding,
    aggregatedClusterRole,
    authDelegatorBinding,
    apiService,
  };
}, "MetricsServer");
