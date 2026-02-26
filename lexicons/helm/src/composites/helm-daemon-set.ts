/**
 * HelmDaemonSet composite — DaemonSet + optional ServiceAccount.
 *
 * Common pattern for logging agents, monitoring sidecars, and node-level
 * infrastructure that needs to run on every node.
 */

import { values, include, printf, toYaml, If } from "../intrinsics";

export interface HelmDaemonSetProps {
  /** Chart and release name. */
  name: string;
  /** Default container image repository. */
  imageRepository?: string;
  /** Default container image tag. */
  imageTag?: string;
  /** Container port (omitted if undefined). */
  port?: number;
  /** Host path volume mounts. */
  hostPaths?: Array<{ name: string; hostPath: string; mountPath: string }>;
  /** Include ServiceAccount. Default: true. */
  serviceAccount?: boolean;
  /** Chart appVersion. */
  appVersion?: string;
}

export interface HelmDaemonSetResult {
  chart: Record<string, unknown>;
  values: Record<string, unknown>;
  daemonSet: Record<string, unknown>;
  serviceAccount?: Record<string, unknown>;
}

export function HelmDaemonSet(props: HelmDaemonSetProps): HelmDaemonSetResult {
  const {
    name,
    imageRepository = "fluent/fluent-bit",
    imageTag = "latest",
    port,
    hostPaths = [],
    serviceAccount = true,
    appVersion = "1.0.0",
  } = props;

  const chart = {
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} DaemonSet`,
  };

  const valuesObj: Record<string, unknown> = {
    image: {
      repository: imageRepository,
      tag: imageTag,
      pullPolicy: "IfNotPresent",
    },
    resources: {
      limits: { cpu: "200m", memory: "256Mi" },
      requests: { cpu: "100m", memory: "128Mi" },
    },
    nodeSelector: {},
    tolerations: [],
    updateStrategy: {
      type: "RollingUpdate",
      rollingUpdate: {
        maxUnavailable: 1,
      },
    },
  };

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
    resources: toYaml(values.resources),
    securityContext: {
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
  };

  if (port !== undefined) {
    containerSpec.ports = [{ containerPort: port, name: "http" }];
  }

  if (hostPaths.length > 0) {
    containerSpec.volumeMounts = hostPaths.map((hp) => ({
      name: hp.name,
      mountPath: hp.mountPath,
      readOnly: true,
    }));
  }

  const podSpec: Record<string, unknown> = {
    containers: [containerSpec],
    securityContext: {
      runAsNonRoot: true,
    },
    nodeSelector: toYaml(values.nodeSelector),
    tolerations: toYaml(values.tolerations),
  };

  if (serviceAccount) {
    podSpec.serviceAccountName = include(`${name}.serviceAccountName`);
  }

  if (hostPaths.length > 0) {
    podSpec.volumes = hostPaths.map((hp) => ({
      name: hp.name,
      hostPath: {
        path: hp.hostPath,
        type: "Directory",
      },
    }));
  }

  const daemonSet = {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: {
      name: include(`${name}.fullname`),
      labels: include(`${name}.labels`),
    },
    spec: {
      selector: {
        matchLabels: include(`${name}.selectorLabels`),
      },
      updateStrategy: toYaml(values.updateStrategy),
      template: {
        metadata: {
          labels: include(`${name}.selectorLabels`),
        },
        spec: podSpec,
      },
    },
  };

  const result: HelmDaemonSetResult = {
    chart,
    values: valuesObj,
    daemonSet,
  };

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
