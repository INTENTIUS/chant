import { RedisCache, Azure } from "@intentius/chant-lexicon-azure";

export const { redisCache } = RedisCache({
  name: "chant-redis",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
