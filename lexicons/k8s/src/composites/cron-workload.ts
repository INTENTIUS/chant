/**
 * CronWorkload composite — CronJob + ServiceAccount + Role + RoleBinding.
 *
 * A higher-level construct for deploying scheduled workloads with
 * proper RBAC permissions.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { CronJob, ServiceAccount, Role, RoleBinding } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface CronWorkloadProps {
  /** Workload name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Cron schedule expression (e.g., "0 * * * *"). */
  schedule: string;
  /** Command to run in the container. */
  command?: string[];
  /** Arguments to the command. */
  args?: string[];
  /** RBAC rules for the service account. */
  rbacRules?: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
  /** Job history limits. */
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  /** Restart policy for the job (default: "OnFailure"). */
  restartPolicy?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    cronJob?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface CronWorkloadResult {
  cronJob: InstanceType<typeof CronJob>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  role: InstanceType<typeof Role>;
  roleBinding: InstanceType<typeof RoleBinding>;
}

/**
 * Create a CronWorkload composite — returns prop objects for
 * a CronJob, ServiceAccount, Role, and RoleBinding.
 *
 * @example
 * ```ts
 * import { CronWorkload } from "@intentius/chant-lexicon-k8s";
 *
 * const { cronJob, serviceAccount, role, roleBinding } = CronWorkload({
 *   name: "db-backup",
 *   image: "postgres:16",
 *   schedule: "0 2 * * *",
 *   command: ["pg_dump", "-h", "postgres", "mydb"],
 *   rbacRules: [
 *     { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
 *   ],
 * });
 * ```
 */
export const CronWorkload = Composite<CronWorkloadProps>((props) => {
  const {
    name,
    image,
    schedule,
    command,
    args,
    rbacRules = [],
    successfulJobsHistoryLimit = 3,
    failedJobsHistoryLimit = 1,
    restartPolicy = "OnFailure",
    labels: extraLabels = {},
    namespace,
    env,
    securityContext,
    defaults: defs,
  } = props;

  const saName = `${name}-sa`;
  const roleName = `${name}-role`;
  const bindingName = `${name}-binding`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const cronJob = new CronJob(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "worker" },
    },
    spec: {
      schedule,
      successfulJobsHistoryLimit,
      failedJobsHistoryLimit,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              serviceAccountName: saName,
              restartPolicy,
              containers: [
                {
                  name,
                  image,
                  ...(command && { command }),
                  ...(args && { args }),
                  ...(env && { env }),
                  ...(securityContext && { securityContext }),
                },
              ],
            },
          },
        },
      },
    },
  }, defs?.cronJob));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "worker" },
    },
  }, defs?.serviceAccount));

  const role = new Role(mergeDefaults({
    metadata: {
      name: roleName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: rbacRules.length > 0 ? rbacRules : [
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    ],
  }, defs?.role));

  const roleBinding = new RoleBinding(mergeDefaults({
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

  return { cronJob, serviceAccount, role, roleBinding };
}, "CronWorkload");
