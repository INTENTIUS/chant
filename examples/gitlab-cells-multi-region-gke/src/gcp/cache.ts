import { MemorystoreInstance } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Each cell gets 2 Redis instances: persistent (queues, shared_state) + cache (cache, sessions)

export const persistentRedis = cells.map(c => new MemorystoreInstance({
  metadata: { name: `gitlab-${c.name}-persistent` },
  location: shared.region,
  projectRef: { external: shared.projectId },
  shardCount: 1,
  replicaCount: c.redisPersistentTier === "STANDARD_HA" ? 1 : 0,
  transitEncryptionMode: "SERVER_AUTHENTICATION",
  authorizationMode: "IAM_AUTH",
  engineVersion: "REDIS_7_2",
  engineConfigs: {
    "maxmemory-policy": "noeviction",
  },
  persistenceConfig: {
    mode: "RDB",
    rdbConfig: { rdbSnapshotPeriod: "ONE_HOUR" },
  },
  nodeType: c.redisPersistentSizeGb <= 5 ? "SHARED_CORE_NANO" : "STANDARD_SMALL",
}));

export const cacheRedis = cells.map(c => new MemorystoreInstance({
  metadata: { name: `gitlab-${c.name}-cache` },
  location: shared.region,
  projectRef: { external: shared.projectId },
  shardCount: 1,
  replicaCount: c.redisCacheTier === "STANDARD_HA" ? 1 : 0,
  transitEncryptionMode: "SERVER_AUTHENTICATION",
  authorizationMode: "IAM_AUTH",
  engineVersion: "REDIS_7_2",
  engineConfigs: {
    "maxmemory-policy": "allkeys-lru",
  },
  nodeType: c.redisCacheSizeGb <= 2 ? "SHARED_CORE_NANO" : "STANDARD_SMALL",
}));
