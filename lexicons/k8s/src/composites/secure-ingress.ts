/**
 * SecureIngress composite — Ingress + optional cert-manager Certificate.
 *
 * A standalone Ingress with TLS via cert-manager, supporting
 * multiple hosts and paths (unlike the single-path Ingress in WebApp).
 */

export interface SecureIngressHost {
  /** Hostname (e.g., "api.example.com"). */
  hostname: string;
  /** Path rules for this host. */
  paths: Array<{
    path: string;
    pathType?: string;
    serviceName: string;
    servicePort: number;
  }>;
}

export interface SecureIngressProps {
  /** Ingress name — used in metadata and labels. */
  name: string;
  /** Host definitions with paths. */
  hosts: SecureIngressHost[];
  /** cert-manager ClusterIssuer name — if set, creates a Certificate resource. */
  clusterIssuer?: string;
  /** Ingress class name (e.g., "nginx"). */
  ingressClassName?: string;
  /** Additional annotations on the Ingress. */
  annotations?: Record<string, string>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface SecureIngressResult {
  ingress: Record<string, unknown>;
  certificate?: Record<string, unknown>;
}

/**
 * Create a SecureIngress composite — returns prop objects for
 * an Ingress and optional cert-manager Certificate.
 *
 * @example
 * ```ts
 * import { SecureIngress } from "@intentius/chant-lexicon-k8s";
 *
 * const { ingress, certificate } = SecureIngress({
 *   name: "api-ingress",
 *   hosts: [
 *     {
 *       hostname: "api.example.com",
 *       paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
 *     },
 *   ],
 *   clusterIssuer: "letsencrypt-prod",
 *   ingressClassName: "nginx",
 * });
 * ```
 */
export function SecureIngress(props: SecureIngressProps): SecureIngressResult {
  const {
    name,
    hosts,
    clusterIssuer,
    ingressClassName,
    annotations: extraAnnotations = {},
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const allHostnames = hosts.map((h) => h.hostname);
  const secretName = `${name}-tls`;

  const ingressAnnotations: Record<string, string> = {
    ...extraAnnotations,
  };
  if (clusterIssuer) {
    ingressAnnotations["cert-manager.io/cluster-issuer"] = clusterIssuer;
  }

  const ingressRules = hosts.map((host) => ({
    host: host.hostname,
    http: {
      paths: host.paths.map((p) => ({
        path: p.path,
        pathType: p.pathType ?? "Prefix",
        backend: {
          service: { name: p.serviceName, port: { number: p.servicePort } },
        },
      })),
    },
  }));

  const hasAnnotations = Object.keys(ingressAnnotations).length > 0;

  const ingressProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "ingress" },
      ...(hasAnnotations && { annotations: ingressAnnotations }),
    },
    spec: {
      ...(ingressClassName && { ingressClassName }),
      rules: ingressRules,
      ...(clusterIssuer && {
        tls: [
          {
            hosts: allHostnames,
            secretName,
          },
        ],
      }),
    },
  };

  const result: SecureIngressResult = {
    ingress: ingressProps,
  };

  if (clusterIssuer) {
    result.certificate = {
      metadata: {
        name: secretName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "certificate" },
      },
      spec: {
        secretName,
        issuerRef: {
          name: clusterIssuer,
          kind: "ClusterIssuer",
        },
        dnsNames: allHostnames,
      },
    };
  }

  return result;
}
