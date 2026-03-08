/**
 * GkeFluentBitAgent composite — DaemonSet + RBAC + ConfigMap for Fluent Bit on GKE.
 *
 * @gke Like FluentBitAgent but targets Cloud Logging via the stackdriver
 * output plugin and uses GKE Workload Identity instead of IRSA.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, ConfigMap } from "../generated";

export interface GkeFluentBitAgentProps {
  /** GKE cluster name — used as log stream prefix. */
  clusterName: string;
  /** GCP project ID. */
  projectId: string;
  /** GCP service account email for Workload Identity. */
  gcpServiceAccountEmail?: string;
  /** Agent name (default: "fluent-bit"). */
  name?: string;
  /** Fluent Bit image (default: "fluent/fluent-bit:latest"). */
  image?: string;
  /** Namespace (default: "gke-logging"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** CPU request (default: "50m"). */
  cpuRequest?: string;
  /** Memory request (default: "64Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "200m"). */
  cpuLimit?: string;
  /** Memory limit (default: "128Mi"). */
  memoryLimit?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export interface GkeFluentBitAgentResult {
  daemonSet: InstanceType<typeof DaemonSet>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  configMap: InstanceType<typeof ConfigMap>;
}

/**
 * Create a GkeFluentBitAgent composite — returns prop objects for
 * a DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, and ConfigMap.
 *
 * @gke
 * @example
 * ```ts
 * import { GkeFluentBitAgent } from "@intentius/chant-lexicon-k8s";
 *
 * const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap } = GkeFluentBitAgent({
 *   clusterName: "my-cluster",
 *   projectId: "my-project",
 *   gcpServiceAccountEmail: "fluent-bit@my-project.iam.gserviceaccount.com",
 * });
 * ```
 */
export const GkeFluentBitAgent = Composite<GkeFluentBitAgentProps>((props) => {
  const {
    clusterName,
    projectId,
    gcpServiceAccountEmail,
    name = "fluent-bit",
    image = "fluent/fluent-bit:latest",
    namespace = "gke-logging",
    labels: extraLabels = {},
    cpuRequest = "50m",
    memoryRequest = "64Mi",
    cpuLimit = "200m",
    memoryLimit = "128Mi",
    defaults: defs,
  } = props;

  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;
  const configMapName = `${name}-config`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const fluentBitConfig = `[SERVICE]
    Flush         5
    Log_Level     info
    Daemon        off
    Parsers_File  parsers.conf

[INPUT]
    Name              tail
    Tag               kube.*
    Path              /var/log/containers/*.log
    Parser            docker
    DB                /var/fluent-bit/state/flb_container.db
    Mem_Buf_Limit     5MB
    Skip_Long_Lines   On
    Refresh_Interval  10

[FILTER]
    Name                kubernetes
    Match               kube.*
    Kube_URL            https://kubernetes.default.svc:443
    Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
    Merge_Log           On
    K8S-Logging.Parser  On
    K8S-Logging.Exclude Off

[OUTPUT]
    Name                stackdriver
    Match               *
    google_service_credentials /var/run/secrets/kubernetes.io/serviceaccount/token
    resource            k8s_container
    k8s_cluster_name    ${clusterName}
    k8s_cluster_location ${projectId}
`;

  const container: Record<string, unknown> = {
    name,
    image,
    resources: {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts: [
      { name: "varlog", mountPath: "/var/log", readOnly: true },
      { name: "config", mountPath: `/etc/${name}`, readOnly: true },
      { name: "state", mountPath: "/var/fluent-bit/state" },
    ],
    securityContext: {
      runAsUser: 0,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
  };

  const daemonSet = new DaemonSet(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
    spec: {
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [container],
          volumes: [
            { name: "varlog", hostPath: { path: "/var/log" } },
            { name: "config", configMap: { name: configMapName } },
            { name: "state", hostPath: { path: `/var/fluent-bit/state/${name}` } },
          ],
          tolerations: [{ operator: "Exists" }],
        },
      },
    },
  }, defs?.daemonSet));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
      ...(gcpServiceAccountEmail
        ? { annotations: { "iam.gke.io/gcp-service-account": gcpServiceAccountEmail } }
        : {}),
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["namespaces", "pods"], verbs: ["get", "list", "watch"] },
    ],
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: bindingName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRoleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        namespace,
      },
    ],
  }, defs?.clusterRoleBinding));

  const configMap = new ConfigMap(mergeDefaults({
    metadata: {
      name: configMapName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
    },
    data: {
      "fluent-bit.conf": fluentBitConfig,
    },
  }, defs?.configMap));

  return {
    daemonSet,
    serviceAccount,
    clusterRole,
    clusterRoleBinding,
    configMap,
  };
}, "GkeFluentBitAgent");
