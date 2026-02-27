/**
 * ManagedCertificate composite — ManagedSslCertificate + optional TargetHttpsProxy + UrlMap.
 */

export interface ManagedCertificateProps {
  /** Certificate name. */
  name: string;
  /** Domains for the managed SSL certificate. */
  domains: string[];
  /** Create a TargetHttpsProxy and UrlMap (default: false). */
  createProxy?: boolean;
  /** Backend service name (required if createProxy is true). */
  backendServiceName?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface ManagedCertificateResult {
  certificate: Record<string, unknown>;
  targetHttpsProxy?: Record<string, unknown>;
  urlMap?: Record<string, unknown>;
}

export function ManagedCertificate(props: ManagedCertificateProps): ManagedCertificateResult {
  const {
    name,
    domains,
    createProxy = false,
    backendServiceName,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const certificate: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "certificate" },
    },
    managed: {
      domains,
    },
  };

  const result: ManagedCertificateResult = { certificate };

  if (createProxy && backendServiceName) {
    result.urlMap = {
      metadata: {
        name: `${name}-url-map`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "url-map" },
      },
      defaultService: {
        backendServiceRef: { name: backendServiceName },
      },
    };

    result.targetHttpsProxy = {
      metadata: {
        name: `${name}-proxy`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "proxy" },
      },
      urlMapRef: { name: `${name}-url-map` },
      sslCertificates: [{ name }],
    };
  }

  return result;
}
