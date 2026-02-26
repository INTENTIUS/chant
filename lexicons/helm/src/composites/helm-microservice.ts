/**
 * HelmMicroservice composite — Deployment + Service + Ingress + HPA + PDB + ServiceAccount + ConfigMap.
 *
 * Full microservice pattern with all common production resources.
 */

import { values, include, printf, toYaml, If } from "../intrinsics";

export interface HelmMicroserviceProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Default service port. */
  port?: number;
  /** Default replica count. */
  replicas?: number;
  /** Default service type. */
  serviceType?: string;
  /** Include Ingress (conditional). */
  ingress?: boolean;
  /** Include HPA (conditional). */
  autoscaling?: boolean;
  /** Include PDB. */
  pdb?: boolean;
  /** Include ConfigMap. */
  configMap?: boolean;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmMicroserviceResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  configMap?: Record<string, unknown>;
  ingress?: Record<string, unknown>;
  hpa?: Record<string, unknown>;
  pdb?: Record<string, unknown>;
}

export function HelmMicroservice(props: HelmMicroserviceProps): HelmMicroserviceResult {
  const {
    name,
    imageRepository = "nginx",
    imageTag = "",
    port = 8080,
    replicas = 2,
    serviceType = "ClusterIP",
    ingress = true,
    autoscaling = true,
    pdb = true,
    configMap = true,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} microservice`,
  };

  const valuesObj: Record<string, unknown> = {
    replicaCount: replicas,
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    service: {
      type: serviceType,
      port,
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
    livenessProbe: {
      httpGet: { path: "/healthz", port: "http" },
      initialDelaySeconds: 15,
      periodSeconds: 20,
    },
    readinessProbe: {
      httpGet: { path: "/readyz", port: "http" },
      initialDelaySeconds: 5,
      periodSeconds: 10,
    },
  };

  if (configMap) {
    valuesObj.config = {};
  }

  if (ingress) {
    valuesObj.ingress = {
      enabled: false,
      className: "",
      annotations: {},
      hosts: [{ host: `${name}.local`, paths: [{ path: "/", pathType: "Prefix" }] }],
      tls: [],
    };
  }

  if (autoscaling) {
    valuesObj.autoscaling = {
      enabled: false,
      minReplicas: replicas,
      maxReplicas: 10,
      targetCPUUtilizationPercentage: 80,
      targetMemoryUtilizationPercentage: 80,
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
          containers: [{
            name,
            image: printf("%s:%s", values.image.repository, values.image.tag),
            imagePullPolicy: values.image.pullPolicy,
            ports: [{ containerPort: values.service.port, name: "http" }],
            resources: toYaml(values.resources),
            livenessProbe: toYaml(values.livenessProbe),
            readinessProbe: toYaml(values.readinessProbe),
          }],
        },
      },
    },
  };

  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      type: values.service.type,
      ports: [{
        port: values.service.port,
        targetPort: "http",
        protocol: "TCP",
        name: "http",
      }],
      selector: include(`${name}.selectorLabels`),
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

  const result: HelmMicroserviceResult = {
    chart,
    values: valuesObj,
    deployment,
    service,
    serviceAccount,
  };

  if (configMap) {
    result.configMap = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
      },
      data: values.config,
    };
  }

  if (ingress) {
    result.ingress = {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: include(`${name}.fullname`),
        labels: include(`${name}.labels`),
        annotations: toYaml(values.ingress.annotations),
      },
      spec: {
        ingressClassName: values.ingress.className,
        rules: values.ingress.hosts,
        tls: values.ingress.tls,
      },
    };
  }

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
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: values.autoscaling.targetCPUUtilizationPercentage,
              },
            },
          },
          {
            type: "Resource",
            resource: {
              name: "memory",
              target: {
                type: "Utilization",
                averageUtilization: values.autoscaling.targetMemoryUtilizationPercentage,
              },
            },
          },
        ],
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
