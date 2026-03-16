/**
 * SidecarApp composite — multi-container Deployment + Service.
 *
 * Sidecar and init container patterns (envoy proxy, log forwarder,
 * DB migration init). Supports shared volumes between containers.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface SidecarContainer {
  /** Sidecar container name. */
  name: string;
  /** Container image. */
  image: string;
  /** Container ports. */
  ports?: Array<{ containerPort: number; name?: string }>;
  /** Resource limits and requests. */
  resources?: {
    limits?: { cpu?: string; memory?: string };
    requests?: { cpu?: string; memory?: string };
  };
  /** Environment variables. */
  env?: Array<{ name: string; value: string }>;
}

export interface InitContainer {
  /** Init container name. */
  name: string;
  /** Container image. */
  image: string;
  /** Command to run. */
  command?: string[];
  /** Arguments to the command. */
  args?: string[];
}

export interface SharedVolume {
  /** Volume name. */
  name: string;
  /** Use emptyDir (default). */
  emptyDir?: Record<string, unknown>;
  /** Use a ConfigMap by name. */
  configMapName?: string;
}

export interface SidecarAppProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Primary container image. */
  image: string;
  /** Primary container port (default: 80). */
  port?: number;
  /** Number of replicas (default: 2). */
  replicas?: number;
  /** Sidecar containers. */
  sidecars: SidecarContainer[];
  /** Init containers (run before main containers). */
  initContainers?: InitContainer[];
  /** Shared volumes between containers. */
  sharedVolumes?: SharedVolume[];
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit for the primary container (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit for the primary container (default: "256Mi"). */
  memoryLimit?: string;
  /** CPU request for the primary container (default: "100m"). */
  cpuRequest?: string;
  /** Memory request for the primary container (default: "128Mi"). */
  memoryRequest?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the primary container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context for the primary container (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
  };
}

export interface SidecarAppResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
}

/**
 * Create a SidecarApp composite — returns prop objects for
 * a multi-container Deployment and Service.
 *
 * @example
 * ```ts
 * import { SidecarApp } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service } = SidecarApp({
 *   name: "api",
 *   image: "api:1.0",
 *   port: 8080,
 *   sidecars: [
 *     { name: "envoy", image: "envoyproxy/envoy:v1.28", ports: [{ containerPort: 9901 }] },
 *   ],
 *   initContainers: [
 *     { name: "migrate", image: "api:1.0", command: ["python", "manage.py", "migrate"] },
 *   ],
 *   sharedVolumes: [{ name: "tmp", emptyDir: {} }],
 * });
 * ```
 */
export const SidecarApp = Composite<SidecarAppProps>((props) => {
  const {
    name,
    image,
    port = 80,
    replicas = 2,
    sidecars,
    initContainers,
    sharedVolumes,
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

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Primary container
  const primaryContainer: Record<string, unknown> = {
    name,
    image,
    ports: [{ containerPort: port, name: "http" }],
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
      requests: { cpu: cpuRequest, memory: memoryRequest },
    },
    ...(env && { env }),
    ...(securityContext && { securityContext }),
  };

  // Sidecar containers
  const sidecarContainers = sidecars.map((sc) => ({
    name: sc.name,
    image: sc.image,
    ...(sc.ports && { ports: sc.ports }),
    ...(sc.resources && { resources: sc.resources }),
    ...(sc.env && { env: sc.env }),
  }));

  // Build volumes from sharedVolumes
  const volumes: Array<Record<string, unknown>> | undefined = sharedVolumes?.map((sv) => {
    if (sv.configMapName) {
      return { name: sv.name, configMap: { name: sv.configMapName } };
    }
    return { name: sv.name, emptyDir: sv.emptyDir ?? {} };
  });

  const podSpec: Record<string, unknown> = {
    containers: [primaryContainer, ...sidecarContainers],
    ...(initContainers && {
      initContainers: initContainers.map((ic) => ({
        name: ic.name,
        image: ic.image,
        ...(ic.command && { command: ic.command }),
        ...(ic.args && { args: ic.args }),
      })),
    }),
    ...(volumes && volumes.length > 0 && { volumes }),
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

  return { deployment, service };
}, "SidecarApp");
