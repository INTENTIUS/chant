/**
 * MemorystoreRedis composite — RedisInstance with purpose-driven defaults.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { RedisInstance } from "../generated";

export interface MemorystoreRedisProps {
  /** Instance name. */
  name: string;
  /**
   * Purpose drives the maxmemory-policy default:
   * - "persistent" → "noeviction" (queues, shared_state must not evict)
   * - "cache"      → "allkeys-lru" (cache/sessions can evict LRU)
   */
  purpose: "persistent" | "cache";
  /** Memorystore tier (e.g. "BASIC", "STANDARD_HA"). */
  tier: string;
  /** Memory size in GB. */
  memorySizeGb: number;
  /** GCP region. */
  region: string;
  /** authorizedNetworkRef.name — the VPC network to authorize. */
  networkRef: string;
  /** Redis version (default: "REDIS_7_0"). */
  redisVersion?: string;
  /** Enable AUTH (default: true). */
  authEnabled?: boolean;
  /** Namespace for all resources. */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    instance?: Partial<Record<string, unknown>>;
  };
}

/**
 * Create a MemorystoreRedis composite.
 *
 * @example
 * ```ts
 * import { MemorystoreRedis } from "@intentius/chant-lexicon-gcp";
 *
 * const { instance } = MemorystoreRedis({
 *   name: "my-app-persistent",
 *   purpose: "persistent",
 *   tier: "STANDARD_HA",
 *   memorySizeGb: 5,
 *   region: "us-central1",
 *   networkRef: "my-vpc",
 * });
 * ```
 */
export const MemorystoreRedis = Composite<MemorystoreRedisProps>((props) => {
  const {
    name,
    purpose,
    tier,
    memorySizeGb,
    region,
    networkRef,
    redisVersion = "REDIS_7_0",
    authEnabled = true,
    namespace,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const maxmemoryPolicy = purpose === "persistent" ? "noeviction" : "allkeys-lru";

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const instance = new RedisInstance(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "cache" },
    },
    region,
    tier,
    memorySizeGb,
    authEnabled,
    redisVersion,
    connectMode: "PRIVATE_SERVICE_ACCESS",
    authorizedNetworkRef: { name: networkRef },
    // TLS disabled: GitLab's redis-rb client requires either no TLS or a custom CA cert
    // injected via REDIS_SSL_CA_FILE. AUTH (authEnabled: true) provides access control.
    transitEncryptionMode: "DISABLED",
    redisConfigs: {
      "maxmemory-policy": maxmemoryPolicy,
    },
  } as Record<string, unknown>, defs?.instance));

  return { instance };
}, "MemorystoreRedis");
