/**
 * MonitoredService composite — Deployment + Service + ServiceMonitor + optional PrometheusRule.
 *
 * Observability pattern. ServiceMonitor and PrometheusRule are CRDs
 * from the Prometheus Operator (monitoring.coreos.com/v1), returned
 * as raw objects that can be serialized alongside native K8s resources.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface AlertRule {
  /** Alert name. */
  name: string;
  /** PromQL expression. */
  expr: string;
  /** Duration before firing (e.g., "5m"). */
  for?: string;
  /** Severity label (e.g., "warning", "critical"). */
  severity?: string;
  /** Additional annotations (summary, description). */
  annotations?: Record<string, string>;
}

export interface MonitoredServiceProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Application container port (default: 80). */
  port?: number;
  /** Metrics port (default: 9090). */
  metricsPort?: number;
  /** Metrics path (default: "/metrics"). */
  metricsPath?: string;
  /** Scrape interval (default: "30s"). */
  scrapeInterval?: string;
  /** Alert rules — if provided, creates a PrometheusRule. */
  alertRules?: AlertRule[];
  /** Number of replicas (default: 2). */
  replicas?: number;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "256Mi"). */
  memoryLimit?: string;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "128Mi"). */
  memoryRequest?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    serviceMonitor?: Partial<Record<string, unknown>>;
    prometheusRule?: Partial<Record<string, unknown>>;
  };
}

export interface MonitoredServiceResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  serviceMonitor: InstanceType<typeof Deployment>; // CRD — use Deployment as proxy type
  prometheusRule?: InstanceType<typeof Deployment>; // CRD — use Deployment as proxy type
}

/**
 * Create a MonitoredService composite — returns prop objects for
 * a Deployment, Service, ServiceMonitor, and optional PrometheusRule.
 *
 * @example
 * ```ts
 * import { MonitoredService } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service, serviceMonitor, prometheusRule } = MonitoredService({
 *   name: "api",
 *   image: "api:1.0",
 *   port: 8080,
 *   metricsPort: 9090,
 *   alertRules: [
 *     { name: "HighErrorRate", expr: 'rate(http_errors_total[5m]) > 0.1', for: "5m", severity: "critical" },
 *   ],
 * });
 * ```
 */
export const MonitoredService = Composite<MonitoredServiceProps>((props) => {
  const {
    name,
    image,
    port = 80,
    metricsPort = 9090,
    metricsPath = "/metrics",
    scrapeInterval = "30s",
    alertRules,
    replicas = 2,
    labels: extraLabels = {},
    cpuLimit = "500m",
    memoryLimit = "256Mi",
    cpuRequest = "100m",
    memoryRequest = "128Mi",
    namespace,
    env,
    securityContext,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const ports: Array<Record<string, unknown>> = [
    { containerPort: port, name: "http" },
  ];
  if (metricsPort !== port) {
    ports.push({ containerPort: metricsPort, name: "metrics" });
  }

  const deployment = new Deployment(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          containers: [
            {
              name,
              image,
              ports,
              resources: {
                limits: { cpu: cpuLimit, memory: memoryLimit },
                requests: { cpu: cpuRequest, memory: memoryRequest },
              },
              ...(env && { env }),
              ...(securityContext && { securityContext }),
            },
          ],
        },
      },
    },
  }, defs?.deployment));

  const servicePorts: Array<Record<string, unknown>> = [
    { port: 80, targetPort: port, protocol: "TCP", name: "http" },
  ];
  if (metricsPort !== port) {
    servicePorts.push({ port: metricsPort, targetPort: metricsPort, protocol: "TCP", name: "metrics" });
  }

  const service = new Service(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: servicePorts,
      type: "ClusterIP",
    },
  }, defs?.service));

  // ServiceMonitor is a CRD — use Deployment constructor as a generic Declarable wrapper
  const serviceMonitor = new Deployment(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "monitoring" },
    },
    spec: {
      selector: {
        matchLabels: { "app.kubernetes.io/name": name },
      },
      endpoints: [
        {
          port: "metrics",
          path: metricsPath,
          interval: scrapeInterval,
        },
      ],
    },
  }, defs?.serviceMonitor));

  const result: Record<string, any> = { deployment, service, serviceMonitor };

  if (alertRules && alertRules.length > 0) {
    result.prometheusRule = new Deployment(mergeDefaults({
      metadata: {
        name: `${name}-alerts`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "monitoring" },
      },
      spec: {
        groups: [
          {
            name: `${name}.rules`,
            rules: alertRules.map((rule) => ({
              alert: rule.name,
              expr: rule.expr,
              ...(rule.for && { for: rule.for }),
              labels: {
                ...(rule.severity && { severity: rule.severity }),
              },
              ...(rule.annotations && { annotations: rule.annotations }),
            })),
          },
        ],
      },
    }, defs?.prometheusRule));
  }

  return result;
}, "MonitoredService");
