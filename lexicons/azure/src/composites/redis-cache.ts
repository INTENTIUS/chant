/**
 * RedisCache composite — Azure Cache for Redis.
 *
 * Creates a Redis Cache with non-SSL port disabled and TLS 1.2.
 */

export interface RedisCacheProps {
  /** Redis cache name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** SKU name (default: "Standard"). */
  sku?: string;
  /** SKU family (default: "C"). */
  family?: string;
  /** SKU capacity (default: 1). */
  capacity?: number;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface RedisCacheResult {
  redisCache: Record<string, unknown>;
}

export function RedisCache(props: RedisCacheProps): RedisCacheResult {
  const {
    name,
    location = "[resourceGroup().location]",
    sku = "Standard",
    family = "C",
    capacity = 1,
    tags = {},
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const redisCache: Record<string, unknown> = {
    type: "Microsoft.Cache/redis",
    apiVersion: "2023-08-01",
    name,
    location,
    tags: mergedTags,
    properties: {
      sku: { name: sku, family, capacity },
      enableNonSslPort: false,
      minimumTlsVersion: "1.2",
      redisConfiguration: {},
    },
  };

  return { redisCache };
}
