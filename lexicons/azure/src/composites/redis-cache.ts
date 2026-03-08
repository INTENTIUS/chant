/**
 * RedisCache composite — Azure Cache for Redis.
 *
 * Creates a Redis Cache with non-SSL port disabled and TLS 1.2.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { RedisCache as RedisCacheResource } from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    redisCache?: Partial<ConstructorParameters<typeof RedisCacheResource>[0]>;
  };
}

export interface RedisCacheResult {
  redisCache: InstanceType<typeof RedisCacheResource>;
}

export const RedisCache = Composite<RedisCacheProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    sku = "Standard",
    family = "C",
    capacity = 1,
    tags = {},
    defaults,
  } = props;

  const mergedTags = { "managed-by": "chant", ...tags };

  const redisCache = new RedisCacheResource(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    sku: { name: sku, family, capacity },
    enableNonSslPort: false,
    minimumTlsVersion: "1.2",
    redisConfiguration: {},
  }, defaults?.redisCache), { apiVersion: "2023-08-01" });

  return { redisCache };
}, "RedisCache");
