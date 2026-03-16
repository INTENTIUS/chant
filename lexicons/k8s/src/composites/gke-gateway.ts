/**
 * GkeGateway composite — Gateway + HTTPRoute for GKE Gateway API.
 *
 * @gke Creates a Gateway with a GKE-specific `gatewayClassName` and
 * HTTPRoute resources for traffic routing.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment } from "../generated";

export interface GkeGatewayHost {
  /** Hostname (e.g., "api.example.com"). */
  hostname: string;
  /** Path rules for this host. */
  paths: Array<{
    path: string;
    serviceName: string;
    servicePort: number;
  }>;
}

export interface GkeGatewayProps {
  /** Gateway name — used in metadata and labels. */
  name: string;
  /** GKE gateway class (default: "gke-l7-global-external-managed"). */
  gatewayClassName?:
    | "gke-l7-global-external-managed"
    | "gke-l7-regional-external-managed"
    | "gke-l7-rilb";
  /** Host definitions with paths. */
  hosts: GkeGatewayHost[];
  /** Google-managed certificate name for TLS. */
  certificateName?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    gateway?: Partial<Record<string, unknown>>;
    httpRoute?: Partial<Record<string, unknown>>;
  };
}

export interface GkeGatewayResult {
  gateway: InstanceType<typeof Deployment>; // CRD — use Deployment as proxy Declarable
  httpRoute: InstanceType<typeof Deployment>; // CRD — use Deployment as proxy Declarable
}

/**
 * Create a GkeGateway composite — returns prop objects for
 * a Gateway and HTTPRoute with GKE-specific gateway class.
 *
 * @gke
 * @example
 * ```ts
 * import { GkeGateway } from "@intentius/chant-lexicon-k8s";
 *
 * const { gateway, httpRoute } = GkeGateway({
 *   name: "api-gateway",
 *   hosts: [
 *     {
 *       hostname: "api.example.com",
 *       paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
 *     },
 *   ],
 *   certificateName: "api-cert",
 * });
 * ```
 */
export const GkeGateway = Composite<GkeGatewayProps>((props) => {
  const {
    name,
    gatewayClassName = "gke-l7-global-external-managed",
    hosts,
    certificateName,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const routeName = `${name}-route`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build Gateway listeners
  const listeners: Array<Record<string, unknown>> = [];

  if (certificateName) {
    listeners.push({
      name: "https",
      protocol: "HTTPS",
      port: 443,
      tls: {
        mode: "Terminate",
        certificateRefs: [{ kind: "ManagedCertificate", name: certificateName }],
      },
    });
  } else {
    listeners.push({
      name: "http",
      protocol: "HTTP",
      port: 80,
    });
  }

  // Gateway and HTTPRoute are CRDs — use Deployment constructor as a generic Declarable wrapper
  const gateway = new Deployment(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "gateway" },
    },
    spec: {
      gatewayClassName,
      listeners,
    },
  }, defs?.gateway));

  // Build HTTPRoute rules
  const hostnames = hosts.map((h) => h.hostname);

  const rules = hosts.flatMap((host) =>
    host.paths.map((p) => ({
      matches: [{ path: { type: "PathPrefix", value: p.path } }],
      backendRefs: [
        { name: p.serviceName, port: p.servicePort },
      ],
    })),
  );

  const httpRoute = new Deployment(mergeDefaults({
    metadata: {
      name: routeName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "route" },
    },
    spec: {
      parentRefs: [{ name }],
      hostnames,
      rules,
    },
  }, defs?.httpRoute));

  return { gateway, httpRoute };
}, "GkeGateway");
