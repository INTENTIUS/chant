/**
 * HelmDaemonSet composite — DaemonSet + optional ServiceAccount.
 *
 * Common pattern for logging agents, monitoring sidecars, and node-level
 * infrastructure that needs to run on every node.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, DaemonSet, ServiceAccount } from "../resources";
import { values, include, printf, toYaml, If, With } from "../intrinsics";

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
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
  };
}

export interface HelmDaemonSetResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  daemonSet: InstanceType<typeof DaemonSet>;
  serviceAccount?: InstanceType<typeof ServiceAccount>;
}

export const HelmDaemonSet = Composite<HelmDaemonSetProps>((props) => {
  const {
    name,
    imageRepository = "fluent/fluent-bit",
    imageTag = "latest",
    port,
    hostPaths = [],
    serviceAccount = true,
    appVersion = "1.0.0",
    defaults: defs,
  } = props;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    appVersion,
    type: "application",
    description: `A Helm chart for ${name} DaemonSet`,
  }, defs?.chart));

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

  const valuesRes = new Values(mergeDefaults(valuesObj, defs?.values));

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
    nodeSelector: With(values.nodeSelector, toYaml(values.nodeSelector)),
    tolerations: With(values.tolerations, toYaml(values.tolerations)),
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

  const daemonSet = new DaemonSet(mergeDefaults({
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
  }, defs?.daemonSet));

  const result: Record<string, any> = {
    chart,
    values: valuesRes,
    daemonSet,
  };

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
}, "HelmDaemonSet");
