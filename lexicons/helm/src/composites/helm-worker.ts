/**
 * HelmWorker composite — Deployment (no Service) + ServiceAccount + optional HPA + PDB.
 *
 * Worker pattern for background processors, queue consumers, and async tasks
 * that don't serve HTTP traffic.
 */

import { values, include, printf, toYaml, If } from "../intrinsics";

export interface HelmWorkerProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Default replica count. Default: 2. */
  replicas?: number;
  /** Include HPA (conditional). Default: false. */
  autoscaling?: boolean;
  /** Include PDB. Default: true. */
  pdb?: boolean;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmWorkerResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  deployment: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  hpa?: Record<string, unknown>;
  pdb?: Record<string, unknown>;
}

export function HelmWorker(props: HelmWorkerProps): HelmWorkerResult {
  const {
    name,
    imageRepository = "worker",
    imageTag = "",
    replicas = 2,
    autoscaling = false,
    pdb = true,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} worker`,
  };

  const valuesObj: Record<string, unknown> = {
    replicaCount: replicas,
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    serviceAccount: {
      create: true,
      name: "",
      annotations: {},
    },
    resources: {
      limits: { cpu: "500m", memory: "256Mi" },
      requests: { cpu: "100m", memory: "128Mi" },
    },
    queue: {
      concurrency: 5,
      pollInterval: "5s",
    },
    livenessProbe: {
      exec: { command: ["/bin/sh", "-c", "pgrep -f worker"] },
      initialDelaySeconds: 15,
      periodSeconds: 20,
    },
    readinessProbe: {
      exec: { command: ["/bin/sh", "-c", "pgrep -f worker"] },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    },
  };

  if (autoscaling) {
    valuesObj.autoscaling = {
      enabled: false,
      minReplicas: replicas,
      maxReplicas: 10,
      targetCPUUtilizationPercentage: 80,
    };
  }

  if (pdb) {
    valuesObj.podDisruptionBudget = {
      enabled: true,
      minAvailable: 1,
    };
  }

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      replicas: values.replicaCount,
      selector: {
        matchLabels: include(`${name}.selectorLabels`),
      },
      template: {
        metadata: {
          labels: include(`${name}.selectorLabels`),
        },
        spec: {
          serviceAccountName: include(`${name}.serviceAccountName`),
          securityContext: {
            runAsNonRoot: true,
          },
          containers: [{
            name,
            image: printf("%s:%s", values.image.repository, values.image.tag),
            imagePullPolicy: values.image.pullPolicy,
            resources: toYaml(values.resources),
            livenessProbe: toYaml(values.livenessProbe),
            readinessProbe: toYaml(values.readinessProbe),
            env: [
              { name: "QUEUE_CONCURRENCY", value: values.queue.concurrency },
              { name: "QUEUE_POLL_INTERVAL", value: values.queue.pollInterval },
            ],
          }],
        },
      },
    },
  };

  const serviceAccount = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: include(`${name}.serviceAccountName`),
      labels: include(`${name}.labels`),
      annotations: toYaml(values.serviceAccount.annotations),
    },
  };

  const result: HelmWorkerResult = {
    chart,
    values: valuesObj,
    deployment,
    serviceAccount,
  };

  if (autoscaling) {
    result.hpa = {
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: include(`${name}.fullname`),
        },
        minReplicas: values.autoscaling.minReplicas,
        maxReplicas: values.autoscaling.maxReplicas,
        metrics: [{
          type: "Resource",
          resource: {
            name: "cpu",
            target: {
              type: "Utilization",
              averageUtilization: values.autoscaling.targetCPUUtilizationPercentage,
            },
          },
        }],
      },
    };
  }

  if (pdb) {
    result.pdb = {
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      spec: {
        minAvailable: values.podDisruptionBudget.minAvailable,
        selector: {
          matchLabels: include(`${name}.selectorLabels`),
        },
      },
    };
  }

  return result;
}
