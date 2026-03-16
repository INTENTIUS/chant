/**
 * AzureMonitorCollector composite — DaemonSet + RBAC + ConfigMap for Azure Monitor / OTel collector.
 *
 * @aks Azure Monitor agent with OpenTelemetry collector config for
 * Log Analytics workspace integration on AKS clusters.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, ConfigMap } from "../generated";

export interface AzureMonitorCollectorProps {
  /** Azure Log Analytics workspace ID. */
  workspaceId: string;
  /** AKS cluster name. */
  clusterName: string;
  /** Agent name (default: "azure-monitor-collector"). */
  name?: string;
  /** Collector image (default: "mcr.microsoft.com/azuremonitor/containerinsights/ciprod:3.1.35"). */
  image?: string;
  /** Namespace (default: "azure-monitor"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "256Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "512Mi"). */
  memoryLimit?: string;
  /** Azure AD client ID for Workload Identity (adds azure.workload.identity annotations to ServiceAccount). */
  clientId?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export interface AzureMonitorCollectorResult {
  daemonSet: InstanceType<typeof DaemonSet>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  configMap: InstanceType<typeof ConfigMap>;
}

/**
 * Create an AzureMonitorCollector composite — returns prop objects for
 * a DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, and ConfigMap.
 *
 * @aks
 * @example
 * ```ts
 * import { AzureMonitorCollector } from "@intentius/chant-lexicon-k8s";
 *
 * const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap } = AzureMonitorCollector({
 *   workspaceId: "00000000-0000-0000-0000-000000000000",
 *   clusterName: "my-aks-cluster",
 * });
 * ```
 */
export const AzureMonitorCollector = Composite<AzureMonitorCollectorProps>((props) => {
  const {
    workspaceId,
    clusterName,
    name = "azure-monitor-collector",
    image = "mcr.microsoft.com/azuremonitor/containerinsights/ciprod:3.1.35",
    namespace = "azure-monitor",
    labels: extraLabels = {},
    cpuRequest = "100m",
    memoryRequest = "256Mi",
    cpuLimit = "500m",
    memoryLimit = "512Mi",
    clientId,
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

  // Build OTel collector config YAML for Azure Monitor
  const collectorConfig = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 30s
    send_batch_size: 8192

exporters:
  azuremonitor:
    connection_string: InstrumentationKey=\${APPINSIGHTS_INSTRUMENTATIONKEY}
    endpoint: https://dc.services.visualstudio.com/v2/track
  azuremonitor/logs:
    workspace_id: ${workspaceId}
    cluster_name: ${clusterName}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [azuremonitor]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [azuremonitor]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [azuremonitor/logs]
`;

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [
      { containerPort: 4317, name: "otlp-grpc" },
      { containerPort: 4318, name: "otlp-http" },
    ],
    env: [
      { name: "AKS_CLUSTER_NAME", value: clusterName },
      { name: "WORKSPACE_ID", value: workspaceId },
    ],
    resources: {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts: [
      { name: "config", mountPath: "/etc/otel", readOnly: true },
    ],
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
            { name: "config", configMap: { name: configMapName } },
          ],
          tolerations: [{ operator: "Exists" }],
        },
      },
    },
  }, defs?.daemonSet));

  const saLabels: Record<string, string> = {
    ...commonLabels,
    "app.kubernetes.io/component": "agent",
  };

  if (clientId) {
    saLabels["azure.workload.identity/use"] = "true";
  }

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: saLabels,
      ...(clientId ? { annotations: { "azure.workload.identity/client-id": clientId } } : {}),
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["pods", "nodes", "endpoints"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch"] },
      { apiGroups: [""], resources: ["nodes/proxy"], verbs: ["get"] },
      { apiGroups: [""], resources: ["nodes/stats", "configmaps", "events"], verbs: ["create", "get"] },
      { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "update", "create"], resourceNames: ["otel-container-insight-clusterleader"] },
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
      "config.yaml": collectorConfig,
    },
  }, defs?.configMap));

  return {
    daemonSet,
    serviceAccount,
    clusterRole,
    clusterRoleBinding,
    configMap,
  };
}, "AzureMonitorCollector");
