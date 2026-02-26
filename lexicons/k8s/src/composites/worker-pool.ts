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
  /** PodDisruptionBudget minAvailable — if set, creates a PDB. */
  minAvailable?: number | string;
  /** Pod security context. */
  securityContext?: {
    runAsNonRoot?: boolean;
    readOnlyRootFilesystem?: boolean;
    runAsUser?: number;
    runAsGroup?: number;
  };
  /** Termination grace period in seconds. */
  terminationGracePeriodSeconds?: number;
  /** Priority class name for pod scheduling. */
  priorityClassName?: string;
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
  serviceAccount?: Record<string, unknown>;
  role?: Record<string, unknown>;
  roleBinding?: Record<string, unknown>;
  configMap?: Record<string, unknown>;
  hpa?: Record<string, unknown>;
  pdb?: Record<string, unknown>;
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
    rbacRules,
    autoscaling,
    minAvailable,
    securityContext,
    terminationGracePeriodSeconds,
    priorityClassName,
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

  // undefined → default RBAC rules; explicit [] → no RBAC resources
  const createRbac = rbacRules === undefined || rbacRules.length > 0;
  const effectiveRbacRules = rbacRules === undefined
    ? [{ apiGroups: [""], resources: ["secrets", "configmaps"], verbs: ["get"] }]
    : rbacRules;

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
    ...(securityContext && { securityContext }),
  };

  const podSpec: Record<string, unknown> = {
    ...(createRbac && { serviceAccountName: saName }),
    containers: [container],
    ...(terminationGracePeriodSeconds !== undefined && { terminationGracePeriodSeconds }),
    ...(priorityClassName && { priorityClassName }),
  };

  const deploymentProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "worker" },
    },
    spec: {
      replicas: effectiveReplicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: podSpec,
      },
    },
  };

  const result: WorkerPoolResult = {
    deployment: deploymentProps,
  };

  if (createRbac) {
    result.serviceAccount = {
      metadata: {
        name: saName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "worker" },
      },
    };

    result.role = {
      metadata: {
        name: roleName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
      },
      rules: effectiveRbacRules,
    };

    result.roleBinding = {
      metadata: {
        name: bindingName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
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
  }

  if (config) {
    result.configMap = {
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
      },
      data: config,
    };
  }

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

  if (autoscaling) {
    const targetCPUPercent = autoscaling.targetCPUPercent ?? 70;
    result.hpa = {
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
