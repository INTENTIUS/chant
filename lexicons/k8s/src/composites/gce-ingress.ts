/**
 * GceIngress composite — Ingress with GCE Ingress Controller annotations.
 *
 * @gke Full `kubernetes.io/ingress.*` and `networking.gke.io/*` annotation set
 * including static IP, managed certificates, and FrontendConfig.
 */

export interface GceIngressHost {
  /** Hostname (e.g., "api.example.com"). */
  hostname: string;
  /** Path rules for this host. */
  paths: Array<{
    path: string;
    pathType?: string;
    serviceName: string;
    /** Port on the Kubernetes Service (not the container port). */
    servicePort: number;
  }>;
}

export interface GceIngressProps {
  /** Ingress name — used in metadata and labels. */
  name: string;
  /** Host definitions with paths. */
  hosts: GceIngressHost[];
  /** Global static IP name reserved in GCP (sets `kubernetes.io/ingress.global-static-ip-name`). */
  staticIpName?: string;
  /** GKE managed certificate name (sets `networking.gke.io/managed-certificates`). */
  managedCertificate?: string;
  /** FrontendConfig name for SSL policy / redirects (sets `networking.gke.io/v1beta1.FrontendConfig`). */
  frontendConfig?: string;
  /** Health check path for backend (sets `cloud.google.com/backend-config` is NOT handled here — use BackendConfig CRD). */
  healthCheckPath?: string;
  /** Enable HTTP->HTTPS redirect (default: true when managedCertificate set). */
  sslRedirect?: boolean;
  /** Additional annotations on the Ingress. */
  annotations?: Record<string, string>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface GceIngressResult {
  ingress: Record<string, unknown>;
}

/**
 * Create a GceIngress composite — returns prop objects for
 * an Ingress with GCE Ingress Controller annotations.
 *
 * @gke
 * @example
 * ```ts
 * import { GceIngress } from "@intentius/chant-lexicon-k8s";
 *
 * const { ingress } = GceIngress({
 *   name: "api-ingress",
 *   hosts: [
 *     {
 *       hostname: "api.example.com",
 *       paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
 *     },
 *   ],
 *   staticIpName: "microservice-ip",
 *   managedCertificate: "api-cert",
 * });
 * ```
 */
export function GceIngress(props: GceIngressProps): GceIngressResult {
  const {
    name,
    hosts,
    staticIpName,
    managedCertificate,
    frontendConfig,
    healthCheckPath,
    sslRedirect,
    annotations: extraAnnotations = {},
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build GCE annotations
  const annotations: Record<string, string> = {
    "kubernetes.io/ingress.class": "gce",
    ...extraAnnotations,
  };

  if (staticIpName) {
    annotations["kubernetes.io/ingress.global-static-ip-name"] = staticIpName;
  }

  if (managedCertificate) {
    annotations["networking.gke.io/managed-certificates"] = managedCertificate;
  }

  if (frontendConfig) {
    annotations["networking.gke.io/v1beta1.FrontendConfig"] = frontendConfig;
  }

  if (sslRedirect ?? !!managedCertificate) {
    annotations["networking.gke.io/v1beta1.FrontendConfig"] =
      annotations["networking.gke.io/v1beta1.FrontendConfig"] ?? `${name}-frontend-config`;
  }

  if (healthCheckPath) {
    annotations["cloud.google.com/neg"] = '{"ingress": true}';
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

  const ingressProps: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "ingress" },
      annotations,
    },
    spec: {
      rules: ingressRules,
    },
  };

  return { ingress: ingressProps };
}
