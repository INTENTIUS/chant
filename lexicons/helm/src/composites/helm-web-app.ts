/**
 * HelmWebApp composite — Deployment + Service + Ingress (conditional) + HPA (conditional) + ServiceAccount.
 *
 * Produces a full set of Helm chart entities with parameterized values references.
 */

import { values, include, printf, toYaml, If, With } from "../intrinsics";

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
  /** Liveness probe defaults. */
  livenessProbe?: Record<string, unknown>;
  /** Readiness probe defaults. */
  readinessProbe?: Record<string, unknown>;
  /** Deployment strategy defaults. */
  strategy?: Record<string, unknown>;
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

  if (props.podSecurityContext) valuesObj.podSecurityContext = props.podSecurityContext;
  if (props.securityContext) valuesObj.securityContext = props.securityContext;
  if (props.nodeSelector) valuesObj.nodeSelector = props.nodeSelector;
  if (props.tolerations) valuesObj.tolerations = props.tolerations;
  if (props.affinity) valuesObj.affinity = props.affinity;
  if (props.podAnnotations) valuesObj.podAnnotations = props.podAnnotations;
  if (props.livenessProbe) valuesObj.livenessProbe = props.livenessProbe;
  if (props.readinessProbe) valuesObj.readinessProbe = props.readinessProbe;
  if (props.strategy) valuesObj.strategy = props.strategy;

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

  const containerSpec: Record<string, unknown> = {
    name,
    image: printf("%s:%s", values.image.repository, values.image.tag),
    imagePullPolicy: values.image.pullPolicy,
    ports: [{ containerPort: values.service.port, name: "http" }],
    resources: toYaml(values.resources),
  };

  if (props.securityContext) containerSpec.securityContext = toYaml(values.securityContext);
  if (props.livenessProbe) containerSpec.livenessProbe = toYaml(values.livenessProbe);
  if (props.readinessProbe) containerSpec.readinessProbe = toYaml(values.readinessProbe);

  const podSpec: Record<string, unknown> = {
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
