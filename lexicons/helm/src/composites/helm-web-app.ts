/**
 * HelmWebApp composite — Deployment + Service + Ingress (conditional) + HPA (conditional) + ServiceAccount.
 *
 * Produces a full set of Helm chart entities with parameterized values references.
 */

import { values, include, printf, toYaml, If } from "../intrinsics";

export interface HelmWebAppProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag (empty = appVersion). */
  imageTag?: string;
  /** Default service port. */
  port?: number;
  /** Default replica count. */
  replicas?: number;
  /** Default service type. */
  serviceType?: string;
  /** Include Ingress resource (conditional on values.ingress.enabled). */
  ingress?: boolean;
  /** Include HPA resource (conditional on values.autoscaling.enabled). */
  autoscaling?: boolean;
  /** Include ServiceAccount (conditional on values.serviceAccount.create). */
  serviceAccount?: boolean;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmWebAppResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
  ingress?: Record<string, unknown>;
  hpa?: Record<string, unknown>;
}

export function HelmWebApp(props: HelmWebAppProps): HelmWebAppResult {
  const {
    name,
    imageRepository = "nginx",
    imageTag = "",
    port = 80,
    replicas = 1,
    serviceType = "ClusterIP",
    ingress = true,
    autoscaling = true,
    serviceAccount = true,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name}`,
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
    resources: {},
  };

  if (serviceAccount) {
    valuesObj.serviceAccount = {
      create: true,
      name: "",
      annotations: {},
    };
  }

  if (ingress) {
    valuesObj.ingress = {
      enabled: false,
      className: "",
      annotations: {},
      hosts: [{ host: `${name}.local`, paths: [{ path: "/", pathType: "ImplementationSpecific" }] }],
      tls: [],
    };
  }

  if (autoscaling) {
    valuesObj.autoscaling = {
      enabled: false,
      minReplicas: 1,
      maxReplicas: 100,
      targetCPUUtilizationPercentage: 80,
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
          containers: [{
            name,
            image: printf("%s:%s", values.image.repository, values.image.tag),
            imagePullPolicy: values.image.pullPolicy,
            ports: [{ containerPort: values.service.port, name: "http" }],
            resources: toYaml(values.resources),
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

  const result: HelmWebAppResult = { chart, values: valuesObj, deployment, service };

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

  return result;
}
