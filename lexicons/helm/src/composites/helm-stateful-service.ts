/**
 * HelmStatefulService composite — StatefulSet + headless Service + PVC templates.
 *
 * Produces a Helm chart for stateful workloads with persistent storage.
 */

import { values, include, printf, toYaml, With } from "../intrinsics";

export interface HelmStatefulServiceProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Default replica count. */
  replicas?: number;
  /** Default service port. */
  port?: number;
  /** Default storage size. */
  storageSize?: string;
  /** Default storage class (empty = cluster default). */
  storageClass?: string;
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
  /** Include ServiceAccount. Default: false. */
  serviceAccount?: boolean;
  /** StatefulSet update strategy defaults. */
  updateStrategy?: Record<string, unknown>;
}

export interface HelmStatefulServiceResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  statefulSet: Record<string, unknown>;
  service: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
}

export function HelmStatefulService(props: HelmStatefulServiceProps): HelmStatefulServiceResult {
  const {
    name,
    imageRepository = "postgres",
    imageTag = "16",
    replicas = 1,
    port = 5432,
    storageSize = "10Gi",
    storageClass = "",
    appVersion = "1.0.0",
    serviceAccount = false,
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} (stateful)`,
  };

  const valuesObj: Record<string, unknown> = {
    replicaCount: replicas,
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    service: {
      port,
    },
    persistence: {
      size: storageSize,
      storageClass,
      accessModes: ["ReadWriteOnce"],
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
  if (props.updateStrategy) valuesObj.updateStrategy = props.updateStrategy;

  if (serviceAccount) {
    valuesObj.serviceAccount = {
      create: true,
      name: "",
      annotations: {},
    };
  }

  const containerSpec: Record<string, unknown> = {
    name,
    image: printf("%s:%s", values.image.repository, values.image.tag),
    imagePullPolicy: values.image.pullPolicy,
    ports: [{ containerPort: values.service.port, name: "tcp" }],
    resources: toYaml(values.resources),
    volumeMounts: [{
      name: "data",
      mountPath: "/data",
    }],
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
  if (serviceAccount) podSpec.serviceAccountName = include(`${name}.serviceAccountName`);

  const templateMetadata: Record<string, unknown> = {
    labels: include(`${name}.selectorLabels`),
  };
  if (props.podAnnotations) templateMetadata.annotations = toYaml(values.podAnnotations);

  const statefulSetSpec: Record<string, unknown> = {
    serviceName: include(`${name}.fullname`),
    replicas: values.replicaCount,
    selector: {
      matchLabels: include(`${name}.selectorLabels`),
    },
    template: {
      metadata: templateMetadata,
      spec: podSpec,
    },
    volumeClaimTemplates: [{
      metadata: { name: "data" },
      spec: {
        accessModes: values.persistence.accessModes,
        storageClassName: values.persistence.storageClass,
        resources: {
          requests: { storage: values.persistence.size },
        },
      },
    }],
  };

  if (props.updateStrategy) statefulSetSpec.updateStrategy = toYaml(values.updateStrategy);

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: statefulSetSpec,
  };

  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      clusterIP: "None",
      ports: [{
        port: values.service.port,
        targetPort: "tcp",
        protocol: "TCP",
        name: "tcp",
      }],
      selector: include(`${name}.selectorLabels`),
    },
  };

  const result: HelmStatefulServiceResult = { chart, values: valuesObj, statefulSet, service };

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

  return result;
}
