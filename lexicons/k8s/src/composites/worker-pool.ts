/**
 * WorkerPool composite — Deployment + ServiceAccount + Role + RoleBinding + optional ConfigMap + optional HPA.
 *
 * A higher-level construct for background queue workers (Sidekiq, Celery, Bull)
 * that need RBAC for secrets/configmaps and optional autoscaling, but no Service.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Deployment, ServiceAccount, Role, RoleBinding,
  ConfigMap, HorizontalPodAutoscaler, PodDisruptionBudget,
} from "../generated";
import type { ContainerSecurityContext } from "./security-context";

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
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
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
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
    hpa?: Partial<Record<string, unknown>>;
    pdb?: Partial<Record<string, unknown>>;
  };
}

export interface WorkerPoolResult {
  deployment: InstanceType<typeof Deployment>;
  serviceAccount?: InstanceType<typeof ServiceAccount>;
  role?: InstanceType<typeof Role>;
  roleBinding?: InstanceType<typeof RoleBinding>;
  configMap?: InstanceType<typeof ConfigMap>;
  hpa?: InstanceType<typeof HorizontalPodAutoscaler>;
  pdb?: InstanceType<typeof PodDisruptionBudget>;
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
export const WorkerPool = Composite<WorkerPoolProps>((props) => {
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
    defaults: defs,
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

  const deployment = new Deployment(mergeDefaults({
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
  }, defs?.deployment));

  const result: Record<string, any> = { deployment };

  if (createRbac) {
    result.serviceAccount = new ServiceAccount(mergeDefaults({
      metadata: {
        name: saName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "worker" },
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

  if (config) {
    result.configMap = new ConfigMap(mergeDefaults({
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
      },
      data: config,
    }, defs?.configMap));
  }

  if (minAvailable !== undefined) {
    result.pdb = new PodDisruptionBudget(mergeDefaults({
      metadata: {
        name,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
      },
      spec: {
        minAvailable,
        selector: { matchLabels: { "app.kubernetes.io/name": name } },
      },
    }, defs?.pdb));
  }

  if (autoscaling) {
    const targetCPUPercent = autoscaling.targetCPUPercent ?? 70;
    result.hpa = new HorizontalPodAutoscaler(mergeDefaults({
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
    }, defs?.hpa));
  }

  return result;
}, "WorkerPool");
