/**
 * AdotCollector composite — DaemonSet + RBAC + ConfigMap for AWS Distro for OpenTelemetry.
 *
 * @eks ADOT collector for CloudWatch and X-Ray. NodeAgent specialization
 * with pre-configured pipelines for AWS observability.
 */

export interface AdotCollectorProps {
  /** AWS region. */
  region: string;
  /** EKS cluster name. */
  clusterName: string;
  /** Exporters to enable (default: ["cloudwatch", "xray"]). */
  exporters?: ("cloudwatch" | "xray" | "prometheus")[];
  /** Agent name (default: "adot-collector"). */
  name?: string;
  /** ADOT image (default: "public.ecr.aws/aws-observability/aws-otel-collector:latest"). */
  image?: string;
  /** Namespace (default: "amazon-metrics"). */
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
  /** IAM Role ARN for IRSA (adds eks.amazonaws.com/role-arn annotation to ServiceAccount). */
  iamRoleArn?: string;
}

export interface AdotCollectorResult {
  daemonSet: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
  configMap: Record<string, unknown>;
}

/**
 * Create an AdotCollector composite — returns prop objects for
 * a DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, and ConfigMap.
 *
 * @eks
 * @example
 * ```ts
 * import { AdotCollector } from "@intentius/chant-lexicon-k8s";
 *
 * const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap } = AdotCollector({
 *   region: "us-east-1",
 *   clusterName: "my-cluster",
 *   exporters: ["cloudwatch", "xray"],
 * });
 * ```
 */
export function AdotCollector(props: AdotCollectorProps): AdotCollectorResult {
  const {
    region,
    clusterName,
    exporters = ["cloudwatch", "xray"],
    name = "adot-collector",
    image = "public.ecr.aws/aws-observability/aws-otel-collector:latest",
    namespace = "amazon-metrics",
    labels: extraLabels = {},
    cpuRequest = "100m",
    memoryRequest = "256Mi",
    cpuLimit = "500m",
    memoryLimit = "512Mi",
    iamRoleArn,
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

  // Build ADOT config YAML
  const exporterConfigs: string[] = [];
  const exporterNames: string[] = [];

  if (exporters.includes("cloudwatch")) {
    exporterConfigs.push(`  awsemf:
    region: ${region}
    namespace: ContainerInsights
    log_group_name: '/aws/containerinsights/${clusterName}/performance'
    dimension_rollup_option: NoDimensionRollup`);
    exporterNames.push("awsemf");
  }

  if (exporters.includes("xray")) {
    exporterConfigs.push(`  awsxray:
    region: ${region}`);
    exporterNames.push("awsxray");
  }

  if (exporters.includes("prometheus")) {
    exporterConfigs.push(`  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write`);
    exporterNames.push("prometheusremotewrite");
  }

  const adotConfig = `receivers:
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
${exporterConfigs.join("\n")}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [${exporterNames.filter((e) => e !== "awsxray").join(", ") || "awsemf"}]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [${exporterNames.filter((e) => e !== "awsemf").join(", ") || "awsxray"}]
`;

  const container: Record<string, unknown> = {
    name,
    image,
    args: ["--config=/etc/adot/config.yaml"],
    ports: [
      { containerPort: 4317, name: "otlp-grpc" },
      { containerPort: 4318, name: "otlp-http" },
    ],
    resources: {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts: [
      { name: "config", mountPath: "/etc/adot", readOnly: true },
    ],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
  };

  const daemonSetProps: Record<string, unknown> = {
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
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
      ...(iamRoleArn ? { annotations: { "eks.amazonaws.com/role-arn": iamRoleArn } } : {}),
    },
  };

  const clusterRoleProps: Record<string, unknown> = {
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
  };

  const clusterRoleBindingProps: Record<string, unknown> = {
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
  };

  const configMapProps: Record<string, unknown> = {
    metadata: {
      name: configMapName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
    },
    data: {
      "config.yaml": adotConfig,
    },
  };

  return {
    daemonSet: daemonSetProps,
    serviceAccount: serviceAccountProps,
    clusterRole: clusterRoleProps,
    clusterRoleBinding: clusterRoleBindingProps,
    configMap: configMapProps,
  };
}
