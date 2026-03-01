/**
 * SqlDatabase composite — SQL Server + Database + Firewall Rule.
 *
 * A higher-level construct for deploying an Azure SQL Database with
 * a logical server, a database, and a firewall rule allowing Azure services.
 */

import { markAsAzureResource } from "./from-arm";

export interface SqlDatabaseProps {
  /** SQL server name (globally unique). */
  name: string;
  /** Administrator login name. */
  adminLogin: string;
  /** Administrator login password. */
  adminPassword: string;
  /** Database SKU name (default: "S0"). */
  sku?: string;
  /** Azure region (default: resource group location). */
  location?: string;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface SqlDatabaseResult {
  server: Record<string, unknown>;
  database: Record<string, unknown>;
  firewallRule: Record<string, unknown>;
}

/**
 * Create a SqlDatabase composite — returns property objects for
 * a SQL Server, Database, and Firewall Rule.
 *
 * @example
 * ```ts
 * import { SqlDatabase } from "@intentius/chant-lexicon-azure";
 *
 * const { server, database, firewallRule } = SqlDatabase({
 *   name: "my-sql-server",
 *   adminLogin: "sqladmin",
 *   adminPassword: "P@ssw0rd!",
 *   sku: "S1",
 * });
 *
 * export { server, database, firewallRule };
 * ```
 */
export function SqlDatabase(props: SqlDatabaseProps): SqlDatabaseResult {
  const {
    name,
    adminLogin,
    adminPassword,
    sku = "S0",
    location = "[resourceGroup().location]",
    tags = {},
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const dbName = `${name}-db`;

  const server: Record<string, unknown> = {
    type: "Microsoft.Sql/servers",
    apiVersion: "2022-05-01-preview",
    name,
    location,
    tags: commonTags,
    properties: {
      administratorLogin: adminLogin,
      administratorLoginPassword: adminPassword,
      version: "12.0",
      minimalTlsVersion: "1.2",
      publicNetworkAccess: "Enabled",
    },
  };

  const database: Record<string, unknown> = {
    type: "Microsoft.Sql/servers/databases",
    apiVersion: "2022-05-01-preview",
    name: `${name}/${dbName}`,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    properties: {
      collation: "SQL_Latin1_General_CP1_CI_AS",
      maxSizeBytes: 2147483648,
      catalogCollation: "SQL_Latin1_General_CP1_CI_AS",
      zoneRedundant: false,
    },
  };

  const firewallRule: Record<string, unknown> = {
    type: "Microsoft.Sql/servers/firewallRules",
    apiVersion: "2022-05-01-preview",
    name: `${name}/AllowAllAzureIps`,
    properties: {
      startIpAddress: "0.0.0.0",
      endIpAddress: "0.0.0.0",
    },
  };

  markAsAzureResource(server);
  markAsAzureResource(database);
  markAsAzureResource(firewallRule);

  return { server, database, firewallRule };
}
