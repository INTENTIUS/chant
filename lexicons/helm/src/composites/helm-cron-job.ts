/**
 * HelmCronJob composite — CronJob chart.
 *
 * Produces a Helm chart for scheduled batch workloads.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, CronJob, ServiceAccount } from "../resources";
import { values, include, printf, toYaml, With } from "../intrinsics";

export interface HelmCronJobProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Default cron schedule. */
  schedule?: string;
  /** Default restart policy. */
  restartPolicy?: string;
  /** Chart appVersion. */
  appVersion?: string;
  /** Pod-level security context defaults. */
  podSecurityContext?: Record<string, unknown>;
  /** Container-level security context defaults. */
  securityContext?: Record<string, unknown>;
  /** Node selector defaults. */
  nodeSelector?: Record<string, string>;
  /** Tolerations defaults. */
  tolerations?: Array<Record<string, unknown>>;
  /** Affinity defaults. */
  affinity?: Record<string, unknown>;
  /** Pod annotations defaults. */
  podAnnotations?: Record<string, string>;
  /** Concurrency policy. */
  concurrencyPolicy?: string;
  /** Number of successful job completions to retain. */
  successfulJobsHistoryLimit?: number;
  /** Number of failed job completions to retain. */
  failedJobsHistoryLimit?: number;
  /** Backoff limit for job retries. */
  backoffLimit?: number;
  /** Include ServiceAccount. Default: false. */
  serviceAccount?: boolean;
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    cronJob?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
  };
}

export interface HelmCronJobResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  cronJob: InstanceType<typeof CronJob>;
  serviceAccount?: InstanceType<typeof ServiceAccount>;
}

export const HelmCronJob = Composite<HelmCronJobProps>((props) => {
  const {
    name,
    imageRepository = "busybox",
    imageTag = "latest",
    schedule = "0 * * * *",
    restartPolicy = "OnFailure",
    appVersion = "1.0.0",
    serviceAccount = false,
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} (cron job)`,
  }, defs?.chart));

  const valuesObj: Record<string, unknown> = {
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    schedule,
    restartPolicy,
    command: [],
    args: [],
    resources: {},
  };

  if (props.podSecurityContext) valuesObj.podSecurityContext = props.podSecurityContext;
  if (props.securityContext) valuesObj.securityContext = props.securityContext;
  if (props.nodeSelector) valuesObj.nodeSelector = props.nodeSelector;
  if (props.tolerations) valuesObj.tolerations = props.tolerations;
  if (props.affinity) valuesObj.affinity = props.affinity;
  if (props.podAnnotations) valuesObj.podAnnotations = props.podAnnotations;
  if (props.concurrencyPolicy) valuesObj.concurrencyPolicy = props.concurrencyPolicy;
  if (props.successfulJobsHistoryLimit !== undefined) valuesObj.successfulJobsHistoryLimit = props.successfulJobsHistoryLimit;
  if (props.failedJobsHistoryLimit !== undefined) valuesObj.failedJobsHistoryLimit = props.failedJobsHistoryLimit;
  if (props.backoffLimit !== undefined) valuesObj.backoffLimit = props.backoffLimit;

  if (serviceAccount) {
    valuesObj.serviceAccount = {
      create: true,
      name: "",
      annotations: {},
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
  if (props.affinity) podSpec.affinity = With(values.affinity, toYaml(values.affinity));
  if (serviceAccount) podSpec.serviceAccountName = include(`${name}.serviceAccountName`);

  const templateMetadata: Record<string, unknown> = {
    labels: include(`${name}.selectorLabels`),
  };
  if (props.podAnnotations) templateMetadata.annotations = toYaml(values.podAnnotations);

  const jobSpec: Record<string, unknown> = {
    template: {
      metadata: templateMetadata,
      spec: podSpec,
    },
  };

  if (props.backoffLimit !== undefined) jobSpec.backoffLimit = values.backoffLimit;

  const cronJobSpec: Record<string, unknown> = {
    schedule: values.schedule,
    jobTemplate: {
      spec: jobSpec,
    },
  };

  if (props.concurrencyPolicy) cronJobSpec.concurrencyPolicy = values.concurrencyPolicy;
  if (props.successfulJobsHistoryLimit !== undefined) cronJobSpec.successfulJobsHistoryLimit = values.successfulJobsHistoryLimit;
  if (props.failedJobsHistoryLimit !== undefined) cronJobSpec.failedJobsHistoryLimit = values.failedJobsHistoryLimit;

  const cronJob = new CronJob(mergeDefaults({
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: cronJobSpec,
  }, defs?.cronJob));

  const result: Record<string, any> = { chart, values: valuesRes, cronJob };

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

  return result;
}, "HelmCronJob");
