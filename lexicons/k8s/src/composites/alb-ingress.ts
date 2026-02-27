/**
 * AlbIngress composite — Ingress with AWS Load Balancer Controller annotations.
 *
 * @eks Full `alb.ingress.kubernetes.io/*` annotation set including group name
 * (shared ALB), SSL redirect, subnets, security groups.
 */

export interface AlbIngressHost {
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

export interface AlbIngressProps {
  /** Ingress name — used in metadata and labels. */
  name: string;
  /** Host definitions with paths. */
  hosts: AlbIngressHost[];
  /** ALB scheme (default: "internet-facing"). */
  scheme?: "internet-facing" | "internal";
  /** Target type (default: "ip"). */
  targetType?: "ip" | "instance";
  /** ACM certificate ARN for TLS. */
  certificateArn?: string;
  /** WAF Web ACL ARN. */
  wafAclArn?: string;
  /** Health check path for target group. */
  healthCheckPath?: string;
  /** Ingress group name for shared ALB. */
  groupName?: string;
  /** Enable HTTP→HTTPS redirect (default: true when certificateArn set). */
  sslRedirect?: boolean;
  /** Additional annotations on the Ingress. */
  annotations?: Record<string, string>;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface AlbIngressResult {
  ingress: Record<string, unknown>;
}

/**
 * Create an AlbIngress composite — returns prop objects for
 * an Ingress with AWS ALB Controller annotations.
 *
 * @eks
 * @example
 * ```ts
 * import { AlbIngress } from "@intentius/chant-lexicon-k8s";
 *
 * const { ingress } = AlbIngress({
 *   name: "api-ingress",
 *   hosts: [
 *     {
 *       hostname: "api.example.com",
 *       paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
 *     },
 *   ],
 *   scheme: "internet-facing",
 *   certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
 *   groupName: "shared-alb",
 * });
 * ```
 */
export function AlbIngress(props: AlbIngressProps): AlbIngressResult {
  const {
    name,
    hosts,
    scheme = "internet-facing",
    targetType = "ip",
    certificateArn,
    wafAclArn,
    healthCheckPath,
    groupName,
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

  // Build ALB annotations
  const annotations: Record<string, string> = {
    "alb.ingress.kubernetes.io/scheme": scheme,
    "alb.ingress.kubernetes.io/target-type": targetType,
    ...extraAnnotations,
  };

  if (certificateArn) {
    annotations["alb.ingress.kubernetes.io/certificate-arn"] = certificateArn;
    annotations["alb.ingress.kubernetes.io/listen-ports"] = '[{"HTTPS":443}]';
  }

  if (sslRedirect ?? !!certificateArn) {
    annotations["alb.ingress.kubernetes.io/ssl-redirect"] = "443";
  }

  if (wafAclArn) {
    annotations["alb.ingress.kubernetes.io/wafv2-acl-arn"] = wafAclArn;
  }

  if (healthCheckPath) {
    annotations["alb.ingress.kubernetes.io/healthcheck-path"] = healthCheckPath;
  }

  if (groupName) {
    annotations["alb.ingress.kubernetes.io/group.name"] = groupName;
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
      ingressClassName: "alb",
      rules: ingressRules,
    },
  };

  return { ingress: ingressProps };
}
