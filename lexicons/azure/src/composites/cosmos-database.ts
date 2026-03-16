/**
 * CosmosDatabase composite — Cosmos DB Account + SQL Database + Container.
 *
 * Creates a Cosmos DB Account with automatic failover, network ACL deny,
 * and TLS 1.2, plus a SQL Database and Container.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  CosmosDb,
  databaseAccounts_sqlDatabases,
  databaseAccounts_sqlDatabases_containers,
} from "../generated";

export interface CosmosDatabaseProps {
  /** Cosmos DB account name. */
  name: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Database name (default: "{name}-db"). */
  databaseName?: string;
  /** Container name (default: "{name}-container"). */
  containerName?: string;
  /** Partition key path (default: "/id"). */
  partitionKeyPath?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
  /** Per-member defaults. */
  defaults?: {
    account?: Partial<ConstructorParameters<typeof CosmosDb>[0]>;
    database?: Partial<ConstructorParameters<typeof databaseAccounts_sqlDatabases>[0]>;
    container?: Partial<ConstructorParameters<typeof databaseAccounts_sqlDatabases_containers>[0]>;
  };
}

export interface CosmosDatabaseResult {
  account: InstanceType<typeof CosmosDb>;
  database: InstanceType<typeof databaseAccounts_sqlDatabases>;
  container: InstanceType<typeof databaseAccounts_sqlDatabases_containers>;
}

export const CosmosDatabase = Composite<CosmosDatabaseProps>((props) => {
  const {
    name,
    location = "[resourceGroup().location]",
    partitionKeyPath = "/id",
    tags = {},
    defaults,
  } = props;

  const databaseName = props.databaseName ?? `${name}-db`;
  const containerName = props.containerName ?? `${name}-container`;
  const mergedTags = { "managed-by": "chant", ...tags };

  const account = new CosmosDb(mergeDefaults({
    name,
    location,
    tags: mergedTags,
    kind: "GlobalDocumentDB",
    databaseAccountOfferType: "Standard",
    enableAutomaticFailover: true,
    minimalTlsVersion: "Tls12",
    publicNetworkAccess: "Disabled",
    networkAclBypass: "None",
    consistencyPolicy: {
      defaultConsistencyLevel: "Session",
    },
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false },
    ],
  }, defaults?.account), { apiVersion: "2023-11-15" });

  const database = new databaseAccounts_sqlDatabases(mergeDefaults({
    name: `${name}/${databaseName}`,
    resource: { id: databaseName },
  }, defaults?.database), {
    apiVersion: "2023-11-15",
    DependsOn: [
      `[resourceId('Microsoft.DocumentDB/databaseAccounts', '${name}')]`,
    ],
  });

  const container = new databaseAccounts_sqlDatabases_containers(mergeDefaults({
    name: `${name}/${databaseName}/${containerName}`,
    resource: {
      id: containerName,
      partitionKey: {
        paths: [partitionKeyPath],
        kind: "Hash",
      },
    },
  }, defaults?.container), {
    apiVersion: "2023-11-15",
    DependsOn: [
      `[resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', '${name}', '${databaseName}')]`,
    ],
  });

  return { account, database, container };
}, "CosmosDatabase");
