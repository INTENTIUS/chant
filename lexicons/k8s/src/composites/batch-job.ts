/**
 * BatchJob composite — Job + optional RBAC (ServiceAccount + Role + RoleBinding).
 *
 * A higher-level construct for one-shot batch jobs (data migrations,
 * seed tasks, backups). For scheduled workloads, use CronWorkload instead.
 */

import type { ContainerSecurityContext } from "./security-context";

export interface BatchJobProps {
  /** Job name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Command to run in the container. */
  command?: string[];
  /** Arguments to the command. */
  args?: string[];
  /** Number of retries before marking the job as failed (default: 6). */
  backoffLimit?: number;
  /** Seconds after completion before the job is eligible for GC. */
  ttlSecondsAfterFinished?: number;
  /** Number of completions required (default: 1). */
  completions?: number;
  /** Number of pods running in parallel (default: 1). */
  parallelism?: number;
  /** Restart policy (default: "OnFailure"). */
  restartPolicy?: string;
  /** RBAC rules for the service account. Omit for defaults; pass [] to skip RBAC entirely. */
  rbacRules?: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "128Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "256Mi"). */
  memoryLimit?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
}

export interface BatchJobResult {
  job: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
  role?: Record<string, unknown>;
  roleBinding?: Record<string, unknown>;
}

/**
 * Create a BatchJob composite — returns prop objects for
 * a Job, and optional ServiceAccount, Role, and RoleBinding.
 *
 * @example
 * ```ts
 * import { BatchJob } from "@intentius/chant-lexicon-k8s";
 *
 * const { job, serviceAccount, role, roleBinding } = BatchJob({
 *   name: "db-migrate",
 *   image: "migrate:1.0",
 *   command: ["python", "manage.py", "migrate"],
 *   backoffLimit: 3,
 *   ttlSecondsAfterFinished: 3600,
 * });
 * ```
 */
export function BatchJob(props: BatchJobProps): BatchJobResult {
  const {
    name,
    image,
    command,
    args,
    backoffLimit = 6,
    ttlSecondsAfterFinished,
    completions = 1,
    parallelism = 1,
    restartPolicy = "OnFailure",
    rbacRules,
    labels: extraLabels = {},
    namespace,
    cpuRequest = "100m",
    memoryRequest = "128Mi",
    cpuLimit = "500m",
    memoryLimit = "256Mi",
    env,
    securityContext,
  } = props;

  const saName = `${name}-sa`;
  const roleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // undefined → default RBAC rules; explicit [] → no RBAC resources
  const createRbac = rbacRules === undefined || rbacRules.length > 0;
  const effectiveRbacRules = rbacRules === undefined
    ? [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }]
    : rbacRules;

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
    ...(securityContext && { securityContext }),
  };

  const jobProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "batch" },
    },
    spec: {
      backoffLimit,
      completions,
      parallelism,
      ...(ttlSecondsAfterFinished !== undefined && { ttlSecondsAfterFinished }),
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          ...(createRbac && { serviceAccountName: saName }),
          restartPolicy,
          containers: [container],
        },
      },
    },
  };

  const result: BatchJobResult = {
    job: jobProps,
  };

  if (createRbac) {
    result.serviceAccount = {
      metadata: {
        name: saName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "batch" },
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

  return result;
}
