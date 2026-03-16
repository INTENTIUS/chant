import { FunctionApp, Azure } from "@intentius/chant-lexicon-azure";

export const { plan, functionApp, storageAccount } = FunctionApp({
  name: "chant-func",
  runtime: "node",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
