/**
 * NetworkIsolatedApp composite — Deployment + Service + NetworkPolicy.
 *
 * Per-app allow rules beyond NamespaceEnv's default-deny.
 * Creates fine-grained ingress/egress policies for a single application.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment, Service, NetworkPolicy } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface NetworkPolicyPeer {
  /** Pod selector for the peer. */
  podSelector?: Record<string, string>;
  /** Namespace selector for the peer. */
  namespaceSelector?: Record<string, string>;
}

export interface NetworkPolicyEgressPeer extends NetworkPolicyPeer {
  /** Allowed ports for egress. */
  ports?: Array<{ port: number; protocol?: string }>;
}

export interface NetworkIsolatedAppProps {
  /** Application name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Container port (default: 80). */
  port?: number;
  /** Number of replicas (default: 2). */
  replicas?: number;
  /** Allowed ingress sources. */
  allowIngressFrom?: NetworkPolicyPeer[];
  /** Allowed egress destinations. */
  allowEgressTo?: NetworkPolicyEgressPeer[];
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "256Mi"). */
  memoryLimit?: string;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "128Mi"). */
  memoryRequest?: string;
  /** Namespace for all resources. */
  namespace?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    deployment?: Partial<Record<string, unknown>>;
    service?: Partial<Record<string, unknown>>;
    networkPolicy?: Partial<Record<string, unknown>>;
  };
}

export interface NetworkIsolatedAppResult {
  deployment: InstanceType<typeof Deployment>;
  service: InstanceType<typeof Service>;
  networkPolicy: InstanceType<typeof NetworkPolicy>;
}

/**
 * Create a NetworkIsolatedApp composite — returns prop objects for
 * a Deployment, Service, and NetworkPolicy.
 *
 * @example
 * ```ts
 * import { NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";
 *
 * const { deployment, service, networkPolicy } = NetworkIsolatedApp({
 *   name: "api",
 *   image: "api:1.0",
 *   port: 8080,
 *   allowIngressFrom: [
 *     { podSelector: { "app.kubernetes.io/name": "frontend" } },
 *   ],
 *   allowEgressTo: [
 *     { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
 *   ],
 * });
 * ```
 */
export const NetworkIsolatedApp = Composite<NetworkIsolatedAppProps>((props) => {
  const {
    name,
    image,
    port = 80,
    replicas = 2,
    allowIngressFrom,
    allowEgressTo,
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
              ...(env && { env }),
              ...(securityContext && { securityContext }),
            },
          ],
        },
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

  // Build network policy
  const policyTypes: string[] = [];
  const policySpec: Record<string, unknown> = {
    podSelector: { matchLabels: { "app.kubernetes.io/name": name } },
  };

  if (allowIngressFrom) {
    policyTypes.push("Ingress");
    policySpec.ingress = [
      {
        from: allowIngressFrom.map((peer) => ({
          ...(peer.podSelector && { podSelector: { matchLabels: peer.podSelector } }),
          ...(peer.namespaceSelector && { namespaceSelector: { matchLabels: peer.namespaceSelector } }),
        })),
        ports: [{ port, protocol: "TCP" }],
      },
    ];
  }

  if (allowEgressTo) {
    policyTypes.push("Egress");
    policySpec.egress = allowEgressTo.map((peer) => ({
      to: [
        {
          ...(peer.podSelector && { podSelector: { matchLabels: peer.podSelector } }),
          ...(peer.namespaceSelector && { namespaceSelector: { matchLabels: peer.namespaceSelector } }),
        },
      ],
      ...(peer.ports && {
        ports: peer.ports.map((p) => ({
          port: p.port,
          protocol: p.protocol ?? "TCP",
        })),
      }),
    }));
  }

  if (policyTypes.length > 0) {
    policySpec.policyTypes = policyTypes;
  }

  const networkPolicy = new NetworkPolicy(mergeDefaults({
    metadata: {
      name: `${name}-policy`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "network-policy" },
    },
    spec: policySpec,
  }, defs?.networkPolicy));

  return { deployment, service, networkPolicy };
}, "NetworkIsolatedApp");
