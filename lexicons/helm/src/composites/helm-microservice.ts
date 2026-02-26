/**
 * HelmMicroservice composite — Deployment + Service + Ingress + HPA + PDB + ServiceAccount + ConfigMap.
 *
 * Full microservice pattern with all common production resources.
 */

import { values, include, printf, toYaml, If, With } from "../intrinsics";

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
  /** Deployment strategy defaults. */
  strategy?: Record<string, unknown>;
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

  if (props.podSecurityContext) valuesObj.podSecurityContext = props.podSecurityContext;
  if (props.securityContext) valuesObj.securityContext = props.securityContext;
  if (props.nodeSelector) valuesObj.nodeSelector = props.nodeSelector;
  if (props.tolerations) valuesObj.tolerations = props.tolerations;
  if (props.affinity) valuesObj.affinity = props.affinity;
  if (props.podAnnotations) valuesObj.podAnnotations = props.podAnnotations;
  if (props.strategy) valuesObj.strategy = props.strategy;

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

  const containerSpec: Record<string, unknown> = {
    name,
    image: printf("%s:%s", values.image.repository, values.image.tag),
    imagePullPolicy: values.image.pullPolicy,
    ports: [{ containerPort: values.service.port, name: "http" }],
    resources: toYaml(values.resources),
    livenessProbe: toYaml(values.livenessProbe),
    readinessProbe: toYaml(values.readinessProbe),
  };

  if (props.securityContext) containerSpec.securityContext = toYaml(values.securityContext);

  const podSpec: Record<string, unknown> = {
    serviceAccountName: include(`${name}.serviceAccountName`),
    containers: [containerSpec],
  };

  if (props.podSecurityContext) podSpec.securityContext = toYaml(values.podSecurityContext);
  if (props.nodeSelector) podSpec.nodeSelector = With(values.nodeSelector, toYaml(values.nodeSelector));
  if (props.tolerations) podSpec.tolerations = With(values.tolerations, toYaml(values.tolerations));
  if (props.affinity) podSpec.affinity = With(values.affinity, toYaml(values.affinity));

  const templateMetadata: Record<string, unknown> = {
    labels: include(`${name}.selectorLabels`),
  };
  if (props.podAnnotations) templateMetadata.annotations = toYaml(values.podAnnotations);

  const deploymentSpec: Record<string, unknown> = {
    replicas: values.replicaCount,
    selector: {
      matchLabels: include(`${name}.selectorLabels`),
    },
    template: {
      metadata: templateMetadata,
      spec: podSpec,
    },
  };

  if (props.strategy) deploymentSpec.strategy = toYaml(values.strategy);

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: deploymentSpec,
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
