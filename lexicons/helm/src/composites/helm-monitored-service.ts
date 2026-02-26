/**
 * HelmMonitoredService composite — Deployment + Service + ServiceMonitor + optional PrometheusRule.
 *
 * Full observability pattern for services monitored by Prometheus Operator.
 * Uses fallback GVK for CRD resources (ServiceMonitor, PrometheusRule).
 */

import { values, include, printf, toYaml, If, With, Capabilities } from "../intrinsics";

export interface HelmMonitoredServiceProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Application port. */
  port?: number;
  /** Metrics port. */
  metricsPort?: number;
  /** Metrics path. */
  metricsPath?: string;
  /** Scrape interval. */
  scrapeInterval?: string;
  /** Default replica count. */
  replicas?: number;
  /** Default service type. */
  serviceType?: string;
  /** Include ServiceAccount. Default: true. */
  serviceAccount?: boolean;
  /** Include PrometheusRule for alerting. Default: false. */
  alertRules?: boolean;
  /** Pod-level security context defaults. */
  podSecurityContext?: Record<string, unknown>;
  /** Container-level security context defaults. */
  securityContext?: Record<string, unknown>;
  /** Node selector defaults. */
  nodeSelector?: Record<string, string>;
  /** Tolerations defaults. */
  tolerations?: Array<Record<string, unknown>>;
  /** Affinity defaults. */
  affinity?: Record<string, unknown>;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmMonitoredServiceResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
  serviceMonitor: Record<string, unknown>;
  prometheusRule?: Record<string, unknown>;
}

export function HelmMonitoredService(props: HelmMonitoredServiceProps): HelmMonitoredServiceResult {
  const {
    name,
    imageRepository = "nginx",
    imageTag = "",
    port = 8080,
    metricsPort = 9090,
    metricsPath = "/metrics",
    scrapeInterval = "30s",
    replicas = 2,
    serviceType = "ClusterIP",
    serviceAccount = true,
    alertRules = false,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} with monitoring`,
  };

  const valuesObj: Record<string, unknown> = {
    replicaCount: replicas,
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    service: {
      type: serviceType,
      port,
    },
    resources: {},
    monitoring: {
      enabled: true,
      metricsPort,
      metricsPath,
      scrapeInterval,
    },
  };

  if (alertRules) {
    valuesObj.alerting = {
      enabled: false,
      rules: [],
    };
  }

  if (props.podSecurityContext) valuesObj.podSecurityContext = props.podSecurityContext;
  if (props.securityContext) valuesObj.securityContext = props.securityContext;
  if (props.nodeSelector) valuesObj.nodeSelector = props.nodeSelector;
  if (props.tolerations) valuesObj.tolerations = props.tolerations;
  if (props.affinity) valuesObj.affinity = props.affinity;

  if (serviceAccount) {
    valuesObj.serviceAccount = {
      create: true,
      name: "",
      annotations: {},
    };
  }

  const containerSpec: Record<string, unknown> = {
    name,
    image: printf("%s:%s", values.image.repository, values.image.tag),
    imagePullPolicy: values.image.pullPolicy,
    ports: [
      { containerPort: values.service.port, name: "http" },
      { containerPort: values.monitoring.metricsPort, name: "metrics" },
    ],
    resources: toYaml(values.resources),
  };

  if (props.securityContext) containerSpec.securityContext = toYaml(values.securityContext);

  const podSpec: Record<string, unknown> = {
    containers: [containerSpec],
  };

  if (props.podSecurityContext) podSpec.securityContext = toYaml(values.podSecurityContext);
  if (props.nodeSelector) podSpec.nodeSelector = With(values.nodeSelector, toYaml(values.nodeSelector));
  if (props.tolerations) podSpec.tolerations = With(values.tolerations, toYaml(values.tolerations));
  if (props.affinity) podSpec.affinity = With(values.affinity, toYaml(values.affinity));
  if (serviceAccount) podSpec.serviceAccountName = include(`${name}.serviceAccountName`);

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      replicas: values.replicaCount,
      selector: {
        matchLabels: include(`${name}.selectorLabels`),
      },
      template: {
        metadata: {
          labels: include(`${name}.selectorLabels`),
        },
        spec: podSpec,
      },
    },
  };

  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      type: values.service.type,
      ports: [
        {
          port: values.service.port,
          targetPort: "http",
          protocol: "TCP",
          name: "http",
        },
        {
          port: values.monitoring.metricsPort,
          targetPort: "metrics",
          protocol: "TCP",
          name: "metrics",
        },
      ],
      selector: include(`${name}.selectorLabels`),
    },
  };

  // ServiceMonitor CRD (monitoring.coreos.com/v1) — gated on Capabilities check
  const serviceMonitor = If(`and .Values.monitoring.enabled (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1")`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      selector: {
        matchLabels: include(`${name}.selectorLabels`),
      },
      endpoints: [{
        port: "metrics",
        path: values.monitoring.metricsPath,
        interval: values.monitoring.scrapeInterval,
      }],
    },
  });

  const result: HelmMonitoredServiceResult = {
    chart,
    values: valuesObj,
    deployment,
    service,
    serviceMonitor: serviceMonitor as unknown as Record<string, unknown>,
  };

  if (serviceAccount) {
    result.serviceAccount = {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: include(`${name}.serviceAccountName`),
        labels: include(`${name}.labels`),
        annotations: toYaml(values.serviceAccount.annotations),
      },
    };
  }

  if (alertRules) {
    result.prometheusRule = If(`and .Values.alerting.enabled (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1")`, {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PrometheusRule",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        groups: [{
          name: printf("%s.rules", name),
          rules: toYaml(values.alerting.rules),
        }],
      },
    }) as unknown as Record<string, unknown>;
  }

  return result;
}
