import { CosmosDatabase, Azure } from "@intentius/chant-lexicon-azure";

export const { account, database, container } = CosmosDatabase({
  name: "chant-cosmos",
  databaseName: "app-db",
  containerName: "items",
  partitionKeyPath: "/tenantId",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "dev" },
});
