import { AppService, Azure } from "@intentius/chant-lexicon-azure";

export const { plan, webApp } = AppService({
  name: "chant-web-app",
  sku: "B1",
  runtime: "NODE|18-lts",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
