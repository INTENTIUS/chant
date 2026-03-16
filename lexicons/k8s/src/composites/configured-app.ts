/**
 * ConfiguredApp composite — Deployment + Service + optional ConfigMap.
 *
 * Wires ConfigMap→Volume→VolumeMount and Secret→Volume→VolumeMount
 * triangles, plus envFrom injection. Covers cdk8s-plus Volume.fromConfigMap(),
 * Volume.fromSecret(), and container.mount() patterns.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service, ConfigMap } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface ConfiguredAppProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Container port (default: 80). */
  port?: number;
  /** Number of replicas (default: 2). */
  replicas?: number;
  /** Config data — creates a ConfigMap. */
  configData?: Record<string, string>;
  /** Mount path for the ConfigMap volume. */
  configMountPath?: string;
  /** Existing Secret name to mount as a volume. */
  secretName?: string;
  /** Mount path for the Secret volume. */
  secretMountPath?: string;
  /** Inject config/secrets as environment variables. */
  envFrom?: {
    configMapRef?: string;
    secretRef?: string;
  };
  /** Init containers (e.g., migrations, cert setup). */
  initContainers?: Array<{
    name: string;
    image: string;
    command?: string[];
    args?: string[];
  }>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "256Mi"). */
  memoryLimit?: string;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "128Mi"). */
  memoryRequest?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export interface ConfiguredAppResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  configMap?: InstanceType<typeof ConfigMap>;
}

/**
 * Create a ConfiguredApp composite — returns prop objects for
 * a Deployment, Service, and optional ConfigMap.
 *
 * @example
 * ```ts
 * import { ConfiguredApp } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service, configMap } = ConfiguredApp({
 *   name: "api",
 *   image: "api:1.0",
 *   port: 8080,
 *   configData: { "app.conf": "key=value" },
 *   configMountPath: "/etc/api",
 *   secretName: "api-creds",
 *   secretMountPath: "/secrets",
 *   envFrom: { secretRef: "api-env-secret" },
 * });
 * ```
 */
export const ConfiguredApp = Composite<ConfiguredAppProps>((props) => {
  const {
    name,
    image,
    port = 80,
    replicas = 2,
    configData,
    configMountPath,
    secretName,
    secretMountPath,
    envFrom,
    initContainers,
    labels: extraLabels = {},
    cpuLimit = "500m",
    memoryLimit = "256Mi",
    cpuRequest = "100m",
    memoryRequest = "128Mi",
    namespace,
    env,
    securityContext,
    defaults: defs,
  } = props;

  const configMapName = `${name}-config`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build volumes and volumeMounts
  const volumes: Array<Record<string, unknown>> = [];
  const volumeMounts: Array<Record<string, unknown>> = [];

  if (configData && configMountPath) {
    volumes.push({
      name: "config",
      configMap: { name: configMapName },
    });
    volumeMounts.push({
      name: "config",
      mountPath: configMountPath,
      readOnly: true,
    });
  }

  if (secretName && secretMountPath) {
    volumes.push({
      name: "secret",
      secret: { secretName },
    });
    volumeMounts.push({
      name: "secret",
      mountPath: secretMountPath,
      readOnly: true,
    });
  }

  // Build envFrom array
  const envFromList: Array<Record<string, unknown>> = [];
  if (envFrom?.configMapRef) {
    envFromList.push({ configMapRef: { name: envFrom.configMapRef } });
  }
  if (envFrom?.secretRef) {
    envFromList.push({ secretRef: { name: envFrom.secretRef } });
  }

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [{ containerPort: port, name: "http" }],
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
      requests: { cpu: cpuRequest, memory: memoryRequest },
    },
    ...(env && { env }),
    ...(envFromList.length > 0 && { envFrom: envFromList }),
    ...(volumeMounts.length > 0 && { volumeMounts }),
    ...(securityContext && { securityContext }),
  };

  const podSpec: Record<string, unknown> = {
    containers: [container],
    ...(volumes.length > 0 && { volumes }),
    ...(initContainers && {
      initContainers: initContainers.map((ic) => ({
        name: ic.name,
        image: ic.image,
        ...(ic.command && { command: ic.command }),
        ...(ic.args && { args: ic.args }),
      })),
    }),
  };

  const deployment = new Deployment(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: podSpec,
      },
    },
  }, defs?.deployment));

  const service = new Service(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "server" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ port: 80, targetPort: port, protocol: "TCP", name: "http" }],
      type: "ClusterIP",
    },
  }, defs?.service));

  const result: Record<string, any> = { deployment, service };

  if (configData) {
    result.configMap = new ConfigMap(mergeDefaults({
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
      },
      data: configData,
    }, defs?.configMap));
  }

  return result;
}, "ConfiguredApp");
