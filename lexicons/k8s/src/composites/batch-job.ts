/**
 * BatchJob composite — Job + optional RBAC (ServiceAccount + Role + RoleBinding).
 *
 * A higher-level construct for one-shot batch jobs (data migrations,
 * seed tasks, backups). For scheduled workloads, use CronWorkload instead.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, ServiceAccount, Role, RoleBinding } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

/** Parse a K8s memory string (e.g. "256Mi", "1Gi") to bytes for comparison. */
function parseMemoryBytes(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|M|G|T|[eE]\d+)?$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    "": 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  };
  if (unit.startsWith("e") || unit.startsWith("E")) return value * 10 ** parseInt(unit.slice(1));
  return value * (multipliers[unit] ?? 1);
}

/** Parse a K8s CPU string (e.g. "500m", "1") to millicores for comparison. */
function parseCpuMillis(cpu: string): number {
  if (cpu.endsWith("m")) return parseFloat(cpu.slice(0, -1));
  return parseFloat(cpu) * 1000;
}

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
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    job?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface BatchJobResult {
  job: InstanceType<typeof Job>;
  serviceAccount?: InstanceType<typeof ServiceAccount>;
  role?: InstanceType<typeof Role>;
  roleBinding?: InstanceType<typeof RoleBinding>;
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
export const BatchJob = Composite<BatchJobProps>((props) => {
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
    memoryRequest: rawMemoryRequest = "128Mi",
    cpuLimit: rawCpuLimit = "500m",
    memoryLimit: rawMemoryLimit = "256Mi",
    env,
    securityContext,
    defaults: defs,
  } = props;

  // Ensure limits >= requests (K8s rejects pods where request > limit).
  const memoryRequest = rawMemoryRequest;
  const memoryLimit = parseMemoryBytes(rawMemoryRequest) > parseMemoryBytes(rawMemoryLimit)
    ? rawMemoryRequest : rawMemoryLimit;
  const cpuLimit = parseCpuMillis(cpuRequest) > parseCpuMillis(rawCpuLimit)
    ? cpuRequest : rawCpuLimit;

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

  const job = new Job(mergeDefaults({
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
  }, defs?.job));

  const result: Record<string, any> = { job };

  if (createRbac) {
    result.serviceAccount = new ServiceAccount(mergeDefaults({
      metadata: {
        name: saName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "batch" },
      },
    }, defs?.serviceAccount));

    result.role = new Role(mergeDefaults({
      metadata: {
        name: roleName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
      },
      rules: effectiveRbacRules,
    }, defs?.role));

    result.roleBinding = new RoleBinding(mergeDefaults({
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
    }, defs?.roleBinding));
  }

  return result;
}, "BatchJob");
