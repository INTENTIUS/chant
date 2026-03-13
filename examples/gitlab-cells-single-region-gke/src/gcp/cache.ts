import { RedisInstance } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Each cell gets 2 Redis instances: persistent (queues, shared_state) + cache (cache, sessions)

export const persistentRedis = cells.map(c => new RedisInstance({
  metadata: { name: `gitlab-${c.name}-persistent` },
  region: shared.region,
  tier: c.redisPersistentTier,
  memorySizeGb: c.redisPersistentSizeGb,
  authEnabled: true,
  redisVersion: "REDIS_7_0",
  connectMode: "PRIVATE_SERVICE_ACCESS",
  authorizedNetworkRef: { name: "gitlab-cells" },
  transitEncryptionMode: "DISABLED",
  redisConfigs: {
    "maxmemory-policy": "noeviction",
  },
}));

export const cacheRedis = cells.map(c => new RedisInstance({
  metadata: { name: `gitlab-${c.name}-cache` },
  region: shared.region,
  tier: c.redisCacheTier,
  memorySizeGb: c.redisCacheSizeGb,
  authEnabled: true,
  redisVersion: "REDIS_7_0",
  connectMode: "PRIVATE_SERVICE_ACCESS",
  authorizedNetworkRef: { name: "gitlab-cells" },
  transitEncryptionMode: "DISABLED",
  redisConfigs: {
    "maxmemory-policy": "allkeys-lru",
  },
}));
