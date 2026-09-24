/**
 * The Kubernetes resources an OpenTelemetry Collector agent needs, shared by
 * `OtelCollector` and `GkeOtelCollector`: a DaemonSet running the collector
 * with its config mounted from a ConfigMap, and a ServiceAccount bound to a
 * ClusterRole that reads pods, nodes and workloads.
 *
 * The caller renders the collector config (with the otel lexicon's
 * `collectorYaml`) and says which ports the container exposes. Everything
 * platform-specific, such as a Workload Identity annotation or probes, comes
 * in as an option, so each composite keeps its own output.
 */

import { mergeDefaults } from "@intentius/chant";
import { DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, ConfigMap } from "../generated";

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
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  /** Extra container fields, such as probes. Added after the standard ones. */
  containerExtra?: Record<string, unknown>;
  /** Annotations on the ServiceAccount, such as a cloud identity binding. */
  serviceAccountAnnotations?: Record<string, string>;
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

  const container: Record<string, unknown> = {
    name,
    image: opts.image,
    args: [`--config=${opts.configDir}/config.yaml`],
    ports: opts.ports,
    resources: {
      requests: { cpu: opts.cpuRequest, memory: opts.memoryRequest },
      limits: { cpu: opts.cpuLimit, memory: opts.memoryLimit },
    },
    volumeMounts: [
      { name: "config", mountPath: opts.configDir, readOnly: true },
    ],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
    ...opts.containerExtra,
  };

  const daemonSet = new DaemonSet(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
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
          ],
          tolerations: [{ operator: "Exists" }],
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
    rules: [
      { apiGroups: [""], resources: ["pods", "nodes", "endpoints"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch"] },
      { apiGroups: [""], resources: ["nodes/proxy"], verbs: ["get"] },
      { apiGroups: [""], resources: ["nodes/stats", "configmaps", "events"], verbs: ["create", "get"] },
      { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "update", "create"], resourceNames: ["otel-container-insight-clusterleader"] },
    ],
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

  const configMap = new ConfigMap(mergeDefaults({
    metadata: {
      name: configMapName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
    },
    data: {
      "config.yaml": opts.configYaml,
    },
  }, defs?.configMap));

  return { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap };
}
