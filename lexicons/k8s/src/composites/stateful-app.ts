/**
 * StatefulApp composite — StatefulSet + headless Service + PVC template.
 *
 * A higher-level construct for deploying stateful applications
 * like databases, caches, and message queues.
 */

import type { ContainerSecurityContext } from "./security-context";

export interface StatefulAppProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image (e.g., "postgres:16"). */
  image: string;
  /** Container port (default: 5432). */
  port?: number;
  /** Number of replicas (default: 1). */
  replicas?: number;
  /** Storage size for the PVC (e.g., "10Gi"). */
  storageSize?: string;
  /** Storage class name. */
  storageClassName?: string;
  /** Volume mount path inside the container (default: "/data"). */
  mountPath?: string;
  /** PodDisruptionBudget minAvailable — if set, creates a PDB. */
  minAvailable?: number | string;
  /** Init containers (e.g., schema migrations, permission setup). */
  initContainers?: Array<{
    name: string;
    image: string;
    command?: string[];
    args?: string[];
  }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Termination grace period in seconds. */
  terminationGracePeriodSeconds?: number;
  /** Priority class name for pod scheduling. */
  priorityClassName?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit (e.g., "1"). */
  cpuLimit?: string;
  /** Memory limit (e.g., "1Gi"). */
  memoryLimit?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
}

export interface StatefulAppResult {
  statefulSet: Record<string, unknown>;
  service: Record<string, unknown>;
  pdb?: Record<string, unknown>;
}

/**
 * Create a StatefulApp composite — returns prop objects for
 * a StatefulSet and headless Service.
 *
 * @example
 * ```ts
 * import { StatefulApp } from "@intentius/chant-lexicon-k8s";
 *
 * const { statefulSet, service } = StatefulApp({
 *   name: "postgres",
 *   image: "postgres:16",
 *   port: 5432,
 *   storageSize: "20Gi",
 *   env: [{ name: "POSTGRES_PASSWORD", value: "changeme" }],
 * });
 * ```
 */
export function StatefulApp(props: StatefulAppProps): StatefulAppResult {
  const {
    name,
    image,
    port = 5432,
    replicas = 1,
    storageSize = "10Gi",
    storageClassName,
    mountPath = "/data",
    minAvailable,
    initContainers,
    securityContext,
    terminationGracePeriodSeconds,
    priorityClassName,
    labels: extraLabels = {},
    cpuLimit = "1",
    memoryLimit = "1Gi",
    namespace,
    env,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [{ containerPort: port, name: "app" }],
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts: [{ name: "data", mountPath }],
    ...(env && { env }),
    ...(securityContext && { securityContext }),
  };

  const podSpec: Record<string, unknown> = {
    containers: [container],
    ...(initContainers && {
      initContainers: initContainers.map((ic) => ({
        name: ic.name,
        image: ic.image,
        ...(ic.command && { command: ic.command }),
        ...(ic.args && { args: ic.args }),
      })),
    }),
    ...(terminationGracePeriodSeconds !== undefined && { terminationGracePeriodSeconds }),
    ...(priorityClassName && { priorityClassName }),
  };

  const statefulSetProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    spec: {
      serviceName: name,
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: podSpec,
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(storageClassName && { storageClassName }),
            resources: { requests: { storage: storageSize } },
          },
        },
      ],
    },
  };

  // Headless service (clusterIP: None) for StatefulSet DNS
  const serviceProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ port, targetPort: port, protocol: "TCP", name: "app" }],
      clusterIP: "None",
    },
  };

  const result: StatefulAppResult = { statefulSet: statefulSetProps, service: serviceProps };

  if (minAvailable !== undefined) {
    result.pdb = {
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
  }

  return result;
}
