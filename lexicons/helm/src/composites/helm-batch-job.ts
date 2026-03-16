/**
 * HelmBatchJob composite — Job + optional ServiceAccount + RBAC.
 *
 * One-shot batch job pattern with optional RBAC for jobs that need
 * Kubernetes API access (e.g., data migrations, cluster operations).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, Job, ServiceAccount, Role, RoleBinding } from "../resources";
import { values, include, printf, toYaml, If, With } from "../intrinsics";

export interface HelmBatchJobProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Backoff limit for retries. */
  backoffLimit?: number;
  /** Number of completions required. */
  completions?: number;
  /** Parallelism level. */
  parallelism?: number;
  /** Default restart policy. */
  restartPolicy?: string;
  /** TTL seconds after job finishes. */
  ttlSecondsAfterFinished?: number;
  /** Include ServiceAccount. Default: true. */
  serviceAccount?: boolean;
  /** Include RBAC (Role + RoleBinding). Default: false. */
  rbac?: boolean;
  /** Pod-level security context defaults. */
  podSecurityContext?: Record<string, unknown>;
  /** Container-level security context defaults. */
  securityContext?: Record<string, unknown>;
  /** Node selector defaults. */
  nodeSelector?: Record<string, string>;
  /** Tolerations defaults. */
  tolerations?: Array<Record<string, unknown>>;
  /** Chart appVersion. */
  appVersion?: string;
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    job?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface HelmBatchJobResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  job: InstanceType<typeof Job>;
  serviceAccount?: InstanceType<typeof ServiceAccount>;
  role?: InstanceType<typeof Role>;
  roleBinding?: InstanceType<typeof RoleBinding>;
}

export const HelmBatchJob = Composite<HelmBatchJobProps>((props) => {
  const {
    name,
    imageRepository = "busybox",
    imageTag = "latest",
    backoffLimit = 6,
    completions = 1,
    parallelism = 1,
    restartPolicy = "OnFailure",
    serviceAccount = true,
    rbac = false,
    appVersion = "1.0.0",
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} batch job`,
  }, defs?.chart));

  const valuesObj: Record<string, unknown> = {
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    job: {
      backoffLimit,
      completions,
      parallelism,
    },
    restartPolicy,
    command: [],
    args: [],
    resources: {},
  };

  if (props.ttlSecondsAfterFinished !== undefined) {
    (valuesObj.job as Record<string, unknown>).ttlSecondsAfterFinished = props.ttlSecondsAfterFinished;
  }

  if (props.podSecurityContext) valuesObj.podSecurityContext = props.podSecurityContext;
  if (props.securityContext) valuesObj.securityContext = props.securityContext;
  if (props.nodeSelector) valuesObj.nodeSelector = props.nodeSelector;
  if (props.tolerations) valuesObj.tolerations = props.tolerations;

  if (serviceAccount) {
    valuesObj.serviceAccount = {
      create: true,
      name: "",
      annotations: {},
    };
  }

  if (rbac) {
    valuesObj.rbac = {
      create: true,
      rules: [],
    };
  }

  const valuesRes = new Values(mergeDefaults(valuesObj, defs?.values));

  const containerSpec: Record<string, unknown> = {
    name,
    image: printf("%s:%s", values.image.repository, values.image.tag),
    imagePullPolicy: values.image.pullPolicy,
    command: values.command,
    args: values.args,
    resources: toYaml(values.resources),
  };

  if (props.securityContext) containerSpec.securityContext = toYaml(values.securityContext);

  const podSpec: Record<string, unknown> = {
    restartPolicy: values.restartPolicy,
    containers: [containerSpec],
  };

  if (props.podSecurityContext) podSpec.securityContext = toYaml(values.podSecurityContext);
  if (props.nodeSelector) podSpec.nodeSelector = With(values.nodeSelector, toYaml(values.nodeSelector));
  if (props.tolerations) podSpec.tolerations = With(values.tolerations, toYaml(values.tolerations));
  if (serviceAccount) podSpec.serviceAccountName = include(`${name}.serviceAccountName`);

  const jobSpec: Record<string, unknown> = {
    backoffLimit: values.job.backoffLimit,
    completions: values.job.completions,
    parallelism: values.job.parallelism,
    template: {
      metadata: {
        labels: include(`${name}.selectorLabels`),
      },
      spec: podSpec,
    },
  };

  if (props.ttlSecondsAfterFinished !== undefined) {
    jobSpec.ttlSecondsAfterFinished = values.job.ttlSecondsAfterFinished;
  }

  const job = new Job(mergeDefaults({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: jobSpec,
  }, defs?.job));

  const result: Record<string, any> = { chart, values: valuesRes, job };

  if (serviceAccount) {
    result.serviceAccount = new ServiceAccount(mergeDefaults({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: include(`${name}.serviceAccountName`),
        labels: include(`${name}.labels`),
        annotations: toYaml(values.serviceAccount.annotations),
      },
    }, defs?.serviceAccount));
  }

  if (rbac) {
    result.role = new Role(mergeDefaults({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      rules: toYaml(values.rbac.rules),
    }, defs?.role));

    result.roleBinding = new RoleBinding(mergeDefaults({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: include(`${name}.fullname`),
      },
      subjects: [{
        kind: "ServiceAccount",
        name: include(`${name}.serviceAccountName`),
        namespace: values.namespace ?? undefined,
      }],
    }, defs?.roleBinding));
  }

  return result;
}, "HelmBatchJob");
