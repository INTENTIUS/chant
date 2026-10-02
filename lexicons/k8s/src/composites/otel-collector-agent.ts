/**
 * The Kubernetes resources an OpenTelemetry Collector agent needs, shared by
 * `OtelCollector` and `GkeOtelCollector`: a DaemonSet running the collector
 * with its config mounted from a ConfigMap, and a ServiceAccount bound to a
 * ClusterRole with the rules the caller works out from its config (see
 * `agentClusterRules` in `otel-collector-rbac.ts`).
 *
 * The caller renders the collector config (with the otel lexicon's
 * `collectorYaml`) and says which ports the container exposes. Everything
 * platform-specific, such as a Workload Identity annotation or probes, comes
 * in as an option, so each composite keeps its own output.
 *
 * `OtelCollectorGateway` runs the same container and ConfigMap
 * (`collectorContainer`, `collectorConfigMap`) in a Deployment.
 */

import { mergeDefaults } from "@intentius/chant";
import { DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, ConfigMap } from "../generated";
import type { CollectorPolicyRule } from "./otel-collector-rbac";
import { nodeVolumeMounts, nodeVolumes, type CollectorNodeAccess } from "./otel-collector-node";

/**
 * How a collector that reads the kubelet's container logs gets past their
 * owner. The files are root's, readable by group root (containerd writes
 * them mode 0640), so `group` keeps user 10001 and adds the pod to group 0
 * with `supplementalGroups`. `root` runs the container as user 0 instead,
 * for a runtime that writes the logs readable by their owner only.
 */
export type CollectorLogAccess = "group" | "root";

export interface CollectorAgentOptions {
  name: string;
  namespace: string;
  image: string;
  /** Labels on every resource, and (with `extraLabels`) on the pod template. */
  commonLabels: Record<string, string>;
  /** Labels the caller added, repeated on the pod template. */
  extraLabels: Record<string, string>;
  /** The rendered collector config, stored under `config.yaml`. */
  configYaml: string;
  /** Directory the config is mounted in. The file is `<dir>/config.yaml`. */
  configDir: string;
  ports: Array<{ containerPort: number; name: string }>;
  /** The ClusterRole's rules, from `agentClusterRules`. */
  clusterRules: CollectorPolicyRule[];
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  /** Extra container fields, such as probes. Added after the standard ones. */
  containerExtra?: Record<string, unknown>;
  /** Annotations on the ServiceAccount, such as a cloud identity binding. */
  serviceAccountAnnotations?: Record<string, string>;
  /** Annotations on the DaemonSet, such as the deployment-shape markers in `otel-collector-shape.ts`. */
  workloadAnnotations?: Record<string, string>;
  /** Annotations on the ConfigMap. */
  configMapAnnotations?: Record<string, string>;
  /** What the config reads from the node, from `collectorNodeAccess`: the node name variables and host mounts. */
  nodeAccess?: CollectorNodeAccess;
  /** How a config that reads container logs gets read access to them (default `group`). */
  logAccess?: CollectorLogAccess;
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export type CollectorAgentResources = {
  daemonSet: InstanceType<typeof DaemonSet>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  configMap: InstanceType<typeof ConfigMap>;
};

export function collectorAgentResources(opts: CollectorAgentOptions): CollectorAgentResources {
  const { name, namespace, commonLabels, extraLabels, defaults: defs } = opts;
  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;
  const configMapName = `${name}-config`;

  const access = opts.nodeAccess;
  const asRoot = access?.readsLogs === true && opts.logAccess === "root";
  const baseContainer = collectorContainer({
    ...opts,
    env: access?.env,
    extraVolumeMounts: access ? nodeVolumeMounts(access.mounts) : undefined,
  });
  const container = asRoot ? runAsRoot(baseContainer) : baseContainer;
  const podSecurity = access?.readsLogs && !asRoot ? { securityContext: { supplementalGroups: [0] } } : {};

  const daemonSet = new DaemonSet(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
      ...(opts.workloadAnnotations ? { annotations: opts.workloadAnnotations } : {}),
    },
    spec: {
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [container],
          volumes: [
            { name: "config", configMap: { name: configMapName } },
            ...(access ? nodeVolumes(access.mounts) : []),
          ],
          tolerations: [{ operator: "Exists" }],
          ...podSecurity,
        },
      },
    },
  }, defs?.daemonSet));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
      ...(opts.serviceAccountAnnotations ? { annotations: opts.serviceAccountAnnotations } : {}),
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: opts.clusterRules,
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: bindingName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRoleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        namespace,
      },
    ],
  }, defs?.clusterRoleBinding));

  const configMap = collectorConfigMap(opts, configMapName, opts.configMapAnnotations);

  return { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap };
}

/** The fields the collector container and its ConfigMap are built from. */
export type CollectorContainerOptions = Pick<
  CollectorAgentOptions,
  "name" | "image" | "configDir" | "ports" | "cpuRequest" | "memoryRequest" | "cpuLimit" | "memoryLimit" | "containerExtra"
> & {
  /** Environment variables, such as the node name from the downward API. Left out when empty. */
  env?: Array<Record<string, unknown>>;
  /** Mounts after the config mount, such as read-only host directories. */
  extraVolumeMounts?: Array<Record<string, unknown>>;
};

/**
 * The collector container: the image, the config file argument, the ports,
 * requests and limits, the config volume mount and a non-root security
 * context, with `containerExtra` laid over the top. The agent DaemonSet and
 * the gateway Deployment run the same container.
 */
export function collectorContainer(opts: CollectorContainerOptions): Record<string, unknown> {
  return {
    name: opts.name,
    image: opts.image,
    args: [`--config=${opts.configDir}/config.yaml`],
    ...(opts.env?.length ? { env: opts.env } : {}),
    ports: opts.ports,
    resources: {
      requests: { cpu: opts.cpuRequest, memory: opts.memoryRequest },
      limits: { cpu: opts.cpuLimit, memory: opts.memoryLimit },
    },
    volumeMounts: [
      { name: "config", mountPath: opts.configDir, readOnly: true },
      ...(opts.extraVolumeMounts ?? []),
    ],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
    ...opts.containerExtra,
  };
}

/** The container run as user 0, for `logAccess: "root"`; the rest of its security context is kept. */
function runAsRoot(container: Record<string, unknown>): Record<string, unknown> {
  const sc = (container.securityContext ?? {}) as Record<string, unknown>;
  return { ...container, securityContext: { ...sc, runAsNonRoot: false, runAsUser: 0 } };
}

/** The ConfigMap holding the rendered collector config under `config.yaml`. */
export function collectorConfigMap(
  opts: Pick<CollectorAgentOptions, "namespace" | "commonLabels" | "configYaml"> & {
    defaults?: { configMap?: Partial<Record<string, unknown>> };
  },
  configMapName: string,
  annotations?: Record<string, string>,
): InstanceType<typeof ConfigMap> {
  return new ConfigMap(mergeDefaults({
    metadata: {
      name: configMapName,
      namespace: opts.namespace,
      labels: { ...opts.commonLabels, "app.kubernetes.io/component": "config" },
      ...(annotations ? { annotations } : {}),
    },
    data: {
      "config.yaml": opts.configYaml,
    },
  }, opts.defaults?.configMap));
}
