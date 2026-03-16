/**
 * ManagedCertificate composite — ManagedSslCertificate + optional TargetHttpsProxy + UrlMap.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { ManagedSSLCertificate, TargetHTTPSProxy, URLMap } from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    certificate?: Partial<ConstructorParameters<typeof ManagedSSLCertificate>[0]>;
    targetHttpsProxy?: Partial<ConstructorParameters<typeof TargetHTTPSProxy>[0]>;
    urlMap?: Partial<ConstructorParameters<typeof URLMap>[0]>;
  };
}

export const ManagedCertificate = Composite<ManagedCertificateProps>((props) => {
  const {
    name,
    domains,
    createProxy = false,
    backendServiceName,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const certificate = new ManagedSSLCertificate(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "certificate" },
    },
    managed: {
      domains,
    },
  } as Record<string, unknown>, defs?.certificate));

  const result: Record<string, any> = { certificate };

  if (createProxy && backendServiceName) {
    result.urlMap = new URLMap(mergeDefaults({
      metadata: {
        name: `${name}-url-map`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "url-map" },
      },
      defaultService: {
        backendServiceRef: { name: backendServiceName },
      },
    } as Record<string, unknown>, defs?.urlMap));

    result.targetHttpsProxy = new TargetHTTPSProxy(mergeDefaults({
      metadata: {
        name: `${name}-proxy`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "proxy" },
      },
      urlMapRef: { name: `${name}-url-map` },
      sslCertificates: [{ name }],
    } as Record<string, unknown>, defs?.targetHttpsProxy));
  }

  return result;
}, "ManagedCertificate");
