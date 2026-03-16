/**
 * WebApp composite — Deployment + Service + optional Ingress.
 *
 * A higher-level construct for deploying stateless web applications
 * with common defaults (health probes, resource limits, labels).
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service, Ingress, PodDisruptionBudget } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface WebAppProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image (e.g., "nginx:1.25"). */
  image: string;
  /** Container port (default: 80). */
  port?: number;
  /** Number of replicas (default: 2). */
  replicas?: number;
  /** Ingress hostname — if set, creates an Ingress resource. */
  ingressHost?: string;
  /** Ingress TLS secret name — if set, enables TLS on the Ingress. */
  ingressTlsSecret?: string;
  /** Multi-path ingress rules — overrides the default single "/" path. */
  ingressPaths?: Array<{
    path: string;
    pathType?: string;
    serviceName?: string;
    servicePort?: number;
  }>;
  /** PodDisruptionBudget minAvailable — if set, creates a PDB. */
  minAvailable?: number | string;
  /** Init containers (e.g., migrations, cert setup). */
  initContainers?: Array<{
    name: string;
    image: string;
    command?: string[];
    args?: string[];
  }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Termination grace period in seconds. */
  terminationGracePeriodSeconds?: number;
  /** Priority class name for pod scheduling. */
  priorityClassName?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit (e.g., "500m"). */
  cpuLimit?: string;
  /** Memory limit (e.g., "256Mi"). */
  memoryLimit?: string;
  /** CPU request (e.g., "100m"). */
  cpuRequest?: string;
  /** Memory request (e.g., "128Mi"). */
  memoryRequest?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    ingress?: Partial<Record<string, unknown>>;
    pdb?: Partial<Record<string, unknown>>;
  };
}

export interface WebAppResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  ingress?: InstanceType<typeof Ingress>;
  pdb?: InstanceType<typeof PodDisruptionBudget>;
}

/**
 * Create a WebApp composite — returns declarable instances for
 * a Deployment, Service, and optional Ingress.
 *
 * @example
 * ```ts
 * import { WebApp } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service, ingress } = WebApp({
 *   name: "my-app",
 *   image: "my-app:1.0",
 *   port: 8080,
 *   replicas: 3,
 *   ingressHost: "my-app.example.com",
 * });
 *
 * export { deployment, service, ingress };
 * ```
 */
export const WebApp = Composite<WebAppProps>((props) => {
  const {
    name,
    image,
    port = 80,
    replicas = 2,
    labels: extraLabels = {},
    cpuLimit = "500m",
    memoryLimit = "256Mi",
    cpuRequest = "100m",
    memoryRequest = "128Mi",
    namespace,
    env,
    initContainers,
    securityContext,
    terminationGracePeriodSeconds,
    priorityClassName,
    minAvailable,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const container: Record<string, unknown> = {
    name,
    image,
    ports: [{ containerPort: port, name: "http" }],
    resources: {
      limits: { cpu: cpuLimit, memory: memoryLimit },
      requests: { cpu: cpuRequest, memory: memoryRequest },
    },
    livenessProbe: {
      httpGet: { path: "/", port },
      initialDelaySeconds: 10,
      periodSeconds: 10,
    },
    readinessProbe: {
      httpGet: { path: "/", port },
      initialDelaySeconds: 5,
      periodSeconds: 5,
    },
    ...(env && { env }),
    ...(securityContext && { securityContext }),
  };

  const podSpec: Record<string, unknown> = {
    containers: [container],
    ...(initContainers && {
      initContainers: initContainers.map((ic) => ({
        name: ic.name,
        image: ic.image,
        ...(ic.command && { command: ic.command }),
        ...(ic.args && { args: ic.args }),
      })),
    }),
    ...(terminationGracePeriodSeconds !== undefined && { terminationGracePeriodSeconds }),
    ...(priorityClassName && { priorityClassName }),
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

  if (props.ingressHost) {
    // Build paths — use ingressPaths if provided, otherwise default single "/"
    const paths = props.ingressPaths
      ? props.ingressPaths.map((p) => ({
          path: p.path,
          pathType: p.pathType ?? "Prefix",
          backend: {
            service: {
              name: p.serviceName ?? name,
              port: { number: p.servicePort ?? 80 },
            },
          },
        }))
      : [
          {
            path: "/",
            pathType: "Prefix",
            backend: {
              service: { name, port: { number: 80 } },
            },
          },
        ];

    result.ingress = new Ingress(mergeDefaults({
      metadata: {
        name,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "ingress" },
      },
      spec: {
        rules: [
          {
            host: props.ingressHost,
            http: { paths },
          },
        ],
        ...(props.ingressTlsSecret && {
          tls: [
            {
              hosts: [props.ingressHost],
              secretName: props.ingressTlsSecret,
            },
          ],
        }),
      },
    }, defs?.ingress));
  }

  if (minAvailable !== undefined) {
    result.pdb = new PodDisruptionBudget(mergeDefaults({
      metadata: {
        name,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "disruption-budget" },
      },
      spec: {
        minAvailable,
        selector: { matchLabels: { "app.kubernetes.io/name": name } },
      },
    }, defs?.pdb));
  }

  return result;
}, "WebApp");
