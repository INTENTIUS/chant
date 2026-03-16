/**
 * NamespaceEnv composite — Namespace + optional ResourceQuota + LimitRange + NetworkPolicy.
 *
 * A higher-level construct for multi-tenant namespace provisioning with
 * resource guardrails and network isolation.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Namespace, ResourceQuota, LimitRange, NetworkPolicy } from "../generated";

export interface NamespaceEnvProps {
  /** Namespace name. */
  name: string;
  /** Total namespace CPU quota (e.g., "8"). */
  cpuQuota?: string;
  /** Total namespace memory quota (e.g., "16Gi"). */
  memoryQuota?: string;
  /** Maximum pods in namespace. */
  maxPods?: number;
  /** LimitRange default CPU request (e.g., "100m"). */
  defaultCpuRequest?: string;
  /** LimitRange default memory request (e.g., "128Mi"). */
  defaultMemoryRequest?: string;
  /** LimitRange default CPU limit (e.g., "500m"). */
  defaultCpuLimit?: string;
  /** LimitRange default memory limit (e.g., "512Mi"). */
  defaultMemoryLimit?: string;
  /** Create default-deny ingress NetworkPolicy (default: true). */
  defaultDenyIngress?: boolean;
  /** Create default-deny egress NetworkPolicy (default: false). */
  defaultDenyEgress?: boolean;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    namespace?: Partial<Record<string, unknown>>;
    resourceQuota?: Partial<Record<string, unknown>>;
    limitRange?: Partial<Record<string, unknown>>;
    networkPolicy?: Partial<Record<string, unknown>>;
  };
}

export interface NamespaceEnvResult {
  namespace: InstanceType<typeof Namespace>;
  resourceQuota?: InstanceType<typeof ResourceQuota>;
  limitRange?: InstanceType<typeof LimitRange>;
  networkPolicy?: InstanceType<typeof NetworkPolicy>;
}

/**
 * Create a NamespaceEnv composite — returns prop objects for
 * a Namespace, optional ResourceQuota, LimitRange, and NetworkPolicy.
 *
 * @example
 * ```ts
 * import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";
 *
 * const { namespace, resourceQuota, limitRange, networkPolicy } = NamespaceEnv({
 *   name: "team-alpha",
 *   cpuQuota: "8",
 *   memoryQuota: "16Gi",
 *   defaultCpuRequest: "100m",
 *   defaultMemoryRequest: "128Mi",
 *   defaultDenyIngress: true,
 * });
 * ```
 */
export const NamespaceEnv = Composite<NamespaceEnvProps>((props) => {
  const {
    name,
    cpuQuota,
    memoryQuota,
    maxPods,
    defaultCpuRequest,
    defaultMemoryRequest,
    defaultCpuLimit,
    defaultMemoryLimit,
    defaultDenyIngress = true,
    defaultDenyEgress = false,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const namespace = new Namespace(mergeDefaults({
    metadata: {
      name,
      labels: { ...commonLabels, "app.kubernetes.io/component": "namespace" },
    },
  }, defs?.namespace));

  const result: Record<string, any> = { namespace };

  // ResourceQuota — only if at least one quota prop is set
  const hasQuota = cpuQuota || memoryQuota || maxPods !== undefined;
  if (hasQuota) {
    const hard: Record<string, unknown> = {};
    if (cpuQuota) hard["limits.cpu"] = cpuQuota;
    if (memoryQuota) hard["limits.memory"] = memoryQuota;
    if (maxPods !== undefined) hard.pods = String(maxPods);

    result.resourceQuota = new ResourceQuota(mergeDefaults({
      metadata: {
        name: `${name}-quota`,
        namespace: name,
        labels: { ...commonLabels, "app.kubernetes.io/component": "quota" },
      },
      spec: { hard },
    }, defs?.resourceQuota));
  }

  // LimitRange — only if at least one default limit prop is set
  const hasLimits = defaultCpuRequest || defaultMemoryRequest || defaultCpuLimit || defaultMemoryLimit;

  if (hasQuota && !hasLimits) {
    console.warn(
      `[NamespaceEnv] "${name}": ResourceQuota set but no LimitRange defaults. ` +
      `Pods without explicit resource requests will fail to schedule.`
    );
  }
  if (hasLimits) {
    const defaultLimits: Record<string, string> = {};
    const defaultRequests: Record<string, string> = {};

    if (defaultCpuLimit) defaultLimits.cpu = defaultCpuLimit;
    if (defaultMemoryLimit) defaultLimits.memory = defaultMemoryLimit;
    if (defaultCpuRequest) defaultRequests.cpu = defaultCpuRequest;
    if (defaultMemoryRequest) defaultRequests.memory = defaultMemoryRequest;

    const limit: Record<string, unknown> = { type: "Container" };
    if (Object.keys(defaultLimits).length > 0) limit.default = defaultLimits;
    if (Object.keys(defaultRequests).length > 0) limit.defaultRequest = defaultRequests;

    result.limitRange = new LimitRange(mergeDefaults({
      metadata: {
        name: `${name}-limits`,
        namespace: name,
        labels: { ...commonLabels, "app.kubernetes.io/component": "limits" },
      },
      spec: {
        limits: [limit],
      },
    }, defs?.limitRange));
  }

  // NetworkPolicy — default-deny ingress and/or egress
  const hasNetworkPolicy = defaultDenyIngress || defaultDenyEgress;
  if (hasNetworkPolicy) {
    const policyTypes: string[] = [];
    if (defaultDenyIngress) policyTypes.push("Ingress");
    if (defaultDenyEgress) policyTypes.push("Egress");

    result.networkPolicy = new NetworkPolicy(mergeDefaults({
      metadata: {
        name: `${name}-default-deny`,
        namespace: name,
        labels: { ...commonLabels, "app.kubernetes.io/component": "network-policy" },
      },
      spec: {
        podSelector: {},
        policyTypes,
      },
    }, defs?.networkPolicy));
  }

  return result;
}, "NamespaceEnv");
