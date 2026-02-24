/**
 * AutoscaledService composite — Deployment + Service + HPA + PDB.
 *
 * A higher-level construct for production HTTP services with autoscaling
 * and disruption budget. Enforces that HPA targets match the Deployment,
 * PDB selectors match pod labels, and resource requests are set.
 */

export interface AutoscaledServiceProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image (e.g., "nginx:1.25"). */
  image: string;
  /** Container port (default: 80). */
  port?: number;
  /** Minimum replicas for HPA (default: 2). */
  minReplicas?: number;
  /** Maximum replicas for HPA (required). */
  maxReplicas: number;
  /** Target CPU utilization percentage (default: 70). */
  targetCPUPercent?: number;
  /** Target memory utilization percentage — if set, adds memory metric. */
  targetMemoryPercent?: number;
  /** PDB minAvailable (default: 1). */
  minAvailable?: number | string;
  /** CPU request (required — HPA needs resource requests). */
  cpuRequest: string;
  /** Memory request (required). */
  memoryRequest: string;
  /** CPU limit (optional — left unset if not provided). */
  cpuLimit?: string;
  /** Memory limit (optional — left unset if not provided). */
  memoryLimit?: string;
  /** Topology spread constraints (default: false). true → zone spreading, object → custom. */
  topologySpread?: boolean | {
    maxSkew?: number;
    topologyKey?: string;
  };
  /** Liveness probe path (default: "/healthz"). */
  livenessPath?: string;
  /** Readiness probe path (default: "/readyz"). */
  readinessPath?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
}

export interface AutoscaledServiceResult {
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  hpa: Record<string, unknown>;
  pdb: Record<string, unknown>;
}

/**
 * Create an AutoscaledService composite — returns prop objects for
 * a Deployment, Service, HorizontalPodAutoscaler, and PodDisruptionBudget.
 *
 * @example
 * ```ts
 * import { AutoscaledService } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service, hpa, pdb } = AutoscaledService({
 *   name: "api",
 *   image: "api:1.0",
 *   maxReplicas: 10,
 *   cpuRequest: "100m",
 *   memoryRequest: "128Mi",
 * });
 * ```
 */
export function AutoscaledService(props: AutoscaledServiceProps): AutoscaledServiceResult {
  const {
    name,
    image,
    port = 80,
    minReplicas = 2,
    maxReplicas,
    targetCPUPercent = 70,
    targetMemoryPercent,
    minAvailable = 1,
    cpuRequest,
    memoryRequest,
    cpuLimit,
    memoryLimit,
    topologySpread = false,
    livenessPath = "/healthz",
    readinessPath = "/readyz",
    labels: extraLabels = {},
    namespace,
    env,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build topologySpreadConstraints if enabled
  const topologyConstraints: Array<Record<string, unknown>> | undefined = (() => {
    if (!topologySpread) return undefined;
    const maxSkew = typeof topologySpread === "object" ? (topologySpread.maxSkew ?? 1) : 1;
    const topologyKey = typeof topologySpread === "object"
      ? (topologySpread.topologyKey ?? "topology.kubernetes.io/zone")
      : "topology.kubernetes.io/zone";
    return [{
      maxSkew,
      topologyKey,
      whenUnsatisfiable: "DoNotSchedule",
      labelSelector: { matchLabels: { "app.kubernetes.io/name": name } },
    }];
  })();

  const resources: Record<string, unknown> = {
    requests: { cpu: cpuRequest, memory: memoryRequest },
    ...(cpuLimit || memoryLimit
      ? {
          limits: {
            ...(cpuLimit && { cpu: cpuLimit }),
            ...(memoryLimit && { memory: memoryLimit }),
          },
        }
      : {}),
  };

  const deploymentProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      replicas: minReplicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          containers: [
            {
              name,
              image,
              ports: [{ containerPort: port, name: "http" }],
              resources,
              livenessProbe: {
                httpGet: { path: livenessPath, port },
                initialDelaySeconds: 10,
                periodSeconds: 10,
              },
              readinessProbe: {
                httpGet: { path: readinessPath, port },
                initialDelaySeconds: 5,
                periodSeconds: 5,
              },
              ...(env && { env }),
            },
          ],
          ...(topologyConstraints && { topologySpreadConstraints: topologyConstraints }),
        },
      },
    },
  };

  const serviceProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ port: 80, targetPort: port, protocol: "TCP", name: "http" }],
      type: "ClusterIP",
    },
  };

  const metrics: Array<Record<string, unknown>> = [
    {
      type: "Resource",
      resource: {
        name: "cpu",
        target: { type: "Utilization", averageUtilization: targetCPUPercent },
      },
    },
  ];

  if (targetMemoryPercent !== undefined) {
    metrics.push({
      type: "Resource",
      resource: {
        name: "memory",
        target: { type: "Utilization", averageUtilization: targetMemoryPercent },
      },
    });
  }

  const hpaProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "autoscaler" },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name,
      },
      minReplicas,
      maxReplicas,
      metrics,
    },
  };

  const pdbProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
    },
    spec: {
      minAvailable,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
    },
  };

  return {
    deployment: deploymentProps,
    service: serviceProps,
    hpa: hpaProps,
    pdb: pdbProps,
  };
}
