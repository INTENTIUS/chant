import { MemorystoreRedis } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Each cell gets 2 Redis instances: persistent (queues, shared_state) + cache (cache, sessions)

export const persistentRedis = cells.map(c => MemorystoreRedis({
  name: `gitlab-${c.name}-persistent`,
  purpose: "persistent",
  tier: c.redisPersistentTier,
  memorySizeGb: c.redisPersistentSizeGb,
  region: shared.region,
  networkRef: shared.clusterName,
}).instance);

export const cacheRedis = cells.map(c => MemorystoreRedis({
  name: `gitlab-${c.name}-cache`,
  purpose: "cache",
  tier: c.redisCacheTier,
  memorySizeGb: c.redisCacheSizeGb,
  region: shared.region,
  networkRef: shared.clusterName,
}).instance);
