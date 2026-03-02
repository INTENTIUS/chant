/**
 * AgicIngress composite — Ingress with Azure Application Gateway Ingress Controller annotations.
 *
 * @aks Full `appgw.ingress.kubernetes.io/*` annotation set including SSL redirect,
 * WAF policy, backend path prefix, and cookie-based affinity.
 */

export interface AgicIngressHost {
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

export interface AgicIngressProps {
  /** Ingress name — used in metadata and labels. */
  name: string;
  /** Host definitions with paths. */
  hosts: AgicIngressHost[];
  /** Azure Key Vault certificate URI or secret name for TLS. */
  certificateArn?: string;
  /** WAF policy resource ID. */
  wafPolicyId?: string;
  /** Health check path for backend. */
  healthCheckPath?: string;
  /** Enable HTTP->HTTPS redirect (default: true when certificateArn set). */
  sslRedirect?: boolean;
  /** Backend path prefix override. */
  backendPathPrefix?: string;
  /** Enable cookie-based affinity (default: false). */
  cookieAffinity?: boolean;
  /** Additional annotations on the Ingress. */
  annotations?: Record<string, string>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface AgicIngressResult {
  ingress: Record<string, unknown>;
}

/**
 * Create an AgicIngress composite — returns prop objects for
 * an Ingress with Azure Application Gateway Ingress Controller annotations.
 *
 * @aks
 * @example
 * ```ts
 * import { AgicIngress } from "@intentius/chant-lexicon-k8s";
 *
 * const { ingress } = AgicIngress({
 *   name: "api-ingress",
 *   hosts: [
 *     {
 *       hostname: "api.example.com",
 *       paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
 *     },
 *   ],
 *   certificateArn: "keyvault-secret-name",
 *   wafPolicyId: "/subscriptions/.../Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/my-waf",
 * });
 * ```
 */
export function AgicIngress(props: AgicIngressProps): AgicIngressResult {
  const {
    name,
    hosts,
    certificateArn,
    wafPolicyId,
    healthCheckPath,
    sslRedirect,
    backendPathPrefix,
    cookieAffinity = false,
    annotations: extraAnnotations = {},
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build AGIC annotations
  const annotations: Record<string, string> = {
    "kubernetes.io/ingress.class": "azure/application-gateway",
    ...extraAnnotations,
  };

  if (sslRedirect ?? (certificateArn !== undefined)) {
    annotations["appgw.ingress.kubernetes.io/ssl-redirect"] = "true";
  }

  if (certificateArn) {
    annotations["appgw.ingress.kubernetes.io/appgw-ssl-certificate"] = certificateArn;
  }

  if (wafPolicyId) {
    annotations["appgw.ingress.kubernetes.io/waf-policy-for-path"] = wafPolicyId;
  }

  if (healthCheckPath) {
    annotations["appgw.ingress.kubernetes.io/health-probe-path"] = healthCheckPath;
  }

  if (backendPathPrefix) {
    annotations["appgw.ingress.kubernetes.io/backend-path-prefix"] = backendPathPrefix;
  }

  if (cookieAffinity) {
    annotations["appgw.ingress.kubernetes.io/cookie-based-affinity"] = "true";
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
