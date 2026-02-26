/**
 * HelmCronJob composite — CronJob chart.
 *
 * Produces a Helm chart for scheduled batch workloads.
 */

import { values, include, printf, toYaml } from "../intrinsics";

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
}

export interface HelmCronJobResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  cronJob: Record<string, unknown>;
}

export function HelmCronJob(props: HelmCronJobProps): HelmCronJobResult {
  const {
    name,
    imageRepository = "busybox",
    imageTag = "latest",
    schedule = "0 * * * *",
    restartPolicy = "OnFailure",
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} (cron job)`,
  };

  const valuesObj = {
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

  const cronJob = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      schedule: values.schedule,
      jobTemplate: {
        spec: {
          template: {
            metadata: {
              labels: include(`${name}.selectorLabels`),
            },
            spec: {
              restartPolicy: values.restartPolicy,
              containers: [{
                name,
                image: printf("%s:%s", values.image.repository, values.image.tag),
                imagePullPolicy: values.image.pullPolicy,
                command: values.command,
                args: values.args,
                resources: toYaml(values.resources),
              }],
            },
          },
        },
      },
    },
  };

  return { chart, values: valuesObj, cronJob };
}
