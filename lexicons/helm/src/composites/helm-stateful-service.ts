/**
 * HelmStatefulService composite — StatefulSet + headless Service + PVC templates.
 *
 * Produces a Helm chart for stateful workloads with persistent storage.
 */

import { values, include, printf, toYaml } from "../intrinsics";

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
}

export interface HelmStatefulServiceResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  statefulSet: Record<string, unknown>;
  service: Record<string, unknown>;
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
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} (stateful)`,
  };

  const valuesObj = {
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

  const statefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      serviceName: include(`${name}.fullname`),
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
            ports: [{ containerPort: values.service.port, name: "tcp" }],
            resources: toYaml(values.resources),
            volumeMounts: [{
              name: "data",
              mountPath: "/data",
            }],
          }],
        },
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

  return { chart, values: valuesObj, statefulSet, service };
}
