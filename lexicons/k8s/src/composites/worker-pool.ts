/**
 * WorkerPool composite — Deployment + ServiceAccount + Role + RoleBinding + optional ConfigMap + optional HPA.
 *
 * A higher-level construct for background queue workers (Sidekiq, Celery, Bull)
 * that need RBAC for secrets/configmaps and optional autoscaling, but no Service.
 */

export interface WorkerPoolProps {
  /** Worker name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Command to run in the container. */
  command?: string[];
  /** Arguments to the command. */
  args?: string[];
  /** Number of replicas (default: 1, ignored if autoscaling). */
  replicas?: number;
  /** Config data — creates a ConfigMap and injects via envFrom. */
  config?: Record<string, string>;
  /** RBAC rules for the service account. */
  rbacRules?: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
  /** Optional autoscaling — creates an HPA when provided. */
  autoscaling?: {
    minReplicas: number;
    maxReplicas: number;
    targetCPUPercent?: number;
  };
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "128Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "256Mi"). */
  memoryLimit?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
}

export interface WorkerPoolResult {
  deployment: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  role: Record<string, unknown>;
  roleBinding: Record<string, unknown>;
  configMap?: Record<string, unknown>;
  hpa?: Record<string, unknown>;
}

/**
 * Create a WorkerPool composite — returns prop objects for
 * a Deployment, ServiceAccount, Role, RoleBinding, optional ConfigMap, and optional HPA.
 *
 * @example
 * ```ts
 * import { WorkerPool } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, serviceAccount, role, roleBinding } = WorkerPool({
 *   name: "email-worker",
 *   image: "worker:1.0",
 *   command: ["bundle", "exec", "sidekiq"],
 *   config: { REDIS_URL: "redis://redis:6379" },
 * });
 * ```
 */
export function WorkerPool(props: WorkerPoolProps): WorkerPoolResult {
  const {
    name,
    image,
    command,
    args,
    replicas = 1,
    config,
    rbacRules = [],
    autoscaling,
    cpuRequest = "100m",
    memoryRequest = "128Mi",
    cpuLimit = "500m",
    memoryLimit = "256Mi",
    labels: extraLabels = {},
    namespace,
    env,
  } = props;

  const saName = `${name}-sa`;
  const roleName = `${name}-role`;
  const bindingName = `${name}-binding`;
  const configMapName = `${name}-config`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const effectiveReplicas = autoscaling ? autoscaling.minReplicas : replicas;

  const container: Record<string, unknown> = {
    name,
    image,
    ...(command && { command }),
    ...(args && { args }),
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
      requests: { cpu: cpuRequest, memory: memoryRequest },
    },
    ...(env && { env }),
    ...(config && {
      envFrom: [{ configMapRef: { name: configMapName } }],
    }),
  };

  const deploymentProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
    spec: {
      replicas: effectiveReplicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [container],
        },
      },
    },
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
  };

  const roleProps: Record<string, unknown> = {
    metadata: {
      name: roleName,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
    rules: rbacRules.length > 0
      ? rbacRules
      : [{ apiGroups: [""], resources: ["secrets", "configmaps"], verbs: ["get"] }],
  };

  const roleBindingProps: Record<string, unknown> = {
    metadata: {
      name: bindingName,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: roleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        ...(namespace && { namespace }),
      },
    ],
  };

  const result: WorkerPoolResult = {
    deployment: deploymentProps,
    serviceAccount: serviceAccountProps,
    role: roleProps,
    roleBinding: roleBindingProps,
  };

  if (config) {
    result.configMap = {
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: commonLabels,
      },
      data: config,
    };
  }

  if (autoscaling) {
    const targetCPUPercent = autoscaling.targetCPUPercent ?? 70;
    result.hpa = {
      metadata: {
        name,
        ...(namespace && { namespace }),
        labels: commonLabels,
      },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name,
        },
        minReplicas: autoscaling.minReplicas,
        maxReplicas: autoscaling.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: { type: "Utilization", averageUtilization: targetCPUPercent },
            },
          },
        ],
      },
    };
  }

  return result;
}
