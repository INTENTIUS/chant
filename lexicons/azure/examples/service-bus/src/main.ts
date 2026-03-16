import { ServiceBusPipeline, Azure } from "@intentius/chant-lexicon-azure";

export const { namespace, queue } = ServiceBusPipeline({
  name: "chant-sb",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
