/**
 * HelmBatchJob composite — Job + optional ServiceAccount + RBAC.
 *
 * One-shot batch job pattern with optional RBAC for jobs that need
 * Kubernetes API access (e.g., data migrations, cluster operations).
 */

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
}

export interface HelmBatchJobResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  job: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
  role?: Record<string, unknown>;
  roleBinding?: Record<string, unknown>;
}

export function HelmBatchJob(props: HelmBatchJobProps): HelmBatchJobResult {
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
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} batch job`,
  };

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

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: jobSpec,
  };

  const result: HelmBatchJobResult = { chart, values: valuesObj, job };

  if (serviceAccount) {
    result.serviceAccount = {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: include(`${name}.serviceAccountName`),
        labels: include(`${name}.labels`),
        annotations: toYaml(values.serviceAccount.annotations),
      },
    };
  }

  if (rbac) {
    result.role = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      rules: toYaml(values.rbac.rules),
    };

    result.roleBinding = {
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
    };
  }

  return result;
}
