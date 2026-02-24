/**
 * WebApp composite — Deployment + Service + optional Ingress.
 *
 * A higher-level construct for deploying stateless web applications
 * with common defaults (health probes, resource limits, labels).
 */

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
}

export interface WebAppResult {
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  ingress?: Record<string, unknown>;
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
export function WebApp(props: WebAppProps): WebAppResult {
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
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // We return plain objects that users pass to constructors.
  // The actual resource instantiation happens in user code with the generated classes.
  const deploymentProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
    spec: {
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          containers: [
            {
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
            },
          ],
        },
      },
    },
  };

  const serviceProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: commonLabels,
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [{ port: 80, targetPort: port, protocol: "TCP", name: "http" }],
      type: "ClusterIP",
    },
  };

  const result: WebAppResult = {
    deployment: deploymentProps,
    service: serviceProps,
  };

  if (props.ingressHost) {
    const ingressProps: Record<string, unknown> = {
      metadata: {
        name,
        ...(namespace && { namespace }),
        labels: commonLabels,
      },
      spec: {
        rules: [
          {
            host: props.ingressHost,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: { name, port: { number: 80 } },
                  },
                },
              ],
            },
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
    };
    result.ingress = ingressProps;
  }

  return result;
}
