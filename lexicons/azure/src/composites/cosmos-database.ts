/**
 * CosmosDatabase composite — Cosmos DB Account + SQL Database + Container.
 *
 * Creates a Cosmos DB Account with automatic failover, network ACL deny,
 * and TLS 1.2, plus a SQL Database and Container.
 */

import { markAsAzureResource } from "./from-arm";

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
}

export interface CosmosDatabaseResult {
  account: Record<string, unknown>;
  database: Record<string, unknown>;
  container: Record<string, unknown>;
}

export function CosmosDatabase(props: CosmosDatabaseProps): CosmosDatabaseResult {
  const {
    name,
    location = "[resourceGroup().location]",
    partitionKeyPath = "/id",
    tags = {},
  } = props;

  const databaseName = props.databaseName ?? `${name}-db`;
  const containerName = props.containerName ?? `${name}-container`;
  const mergedTags = { "managed-by": "chant", ...tags };

  const account: Record<string, unknown> = {
    type: "Microsoft.DocumentDB/databaseAccounts",
    apiVersion: "2023-11-15",
    name,
    location,
    tags: mergedTags,
    kind: "GlobalDocumentDB",
    properties: {
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
    },
  };

  const database: Record<string, unknown> = {
    type: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases",
    apiVersion: "2023-11-15",
    name: `${name}/${databaseName}`,
    properties: {
      resource: { id: databaseName },
    },
    dependsOn: [
      `[resourceId('Microsoft.DocumentDB/databaseAccounts', '${name}')]`,
    ],
  };

  const container: Record<string, unknown> = {
    type: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers",
    apiVersion: "2023-11-15",
    name: `${name}/${databaseName}/${containerName}`,
    properties: {
      resource: {
        id: containerName,
        partitionKey: {
          paths: [partitionKeyPath],
          kind: "Hash",
        },
      },
    },
    dependsOn: [
      `[resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', '${name}', '${databaseName}')]`,
    ],
  };

  markAsAzureResource(account);
  markAsAzureResource(database);
  markAsAzureResource(container);

  return { account, database, container };
}
