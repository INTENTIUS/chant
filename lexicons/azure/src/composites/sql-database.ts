/**
 * SqlDatabase composite — SQL Server + Database + Firewall Rule.
 *
 * A higher-level construct for deploying an Azure SQL Database with
 * a logical server, a database, and a firewall rule allowing Azure services.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { SqlServer, SqlDatabase as SqlDatabaseResource, SqlFirewallRule } from "../generated";

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
  /** Per-member defaults. */
  defaults?: {
    server?: Partial<ConstructorParameters<typeof SqlServer>[0]>;
    database?: Partial<ConstructorParameters<typeof SqlDatabaseResource>[0]>;
    firewallRule?: Partial<ConstructorParameters<typeof SqlFirewallRule>[0]>;
  };
}

export interface SqlDatabaseResult {
  server: InstanceType<typeof SqlServer>;
  database: InstanceType<typeof SqlDatabaseResource>;
  firewallRule: InstanceType<typeof SqlFirewallRule>;
}

/**
 * Create a SqlDatabase composite — returns a SQL Server, Database,
 * and Firewall Rule.
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
export const SqlDatabase = Composite<SqlDatabaseProps>((props) => {
  const {
    name,
    adminLogin,
    adminPassword,
    sku = "S0",
    location = "[resourceGroup().location]",
    tags = {},
    defaults,
  } = props;

  const commonTags: Record<string, string> = {
    "managed-by": "chant",
    ...tags,
  };

  const dbName = `${name}-db`;

  const server = new SqlServer(mergeDefaults({
    name,
    location,
    tags: commonTags,
    administratorLogin: adminLogin,
    administratorLoginPassword: adminPassword,
    version: "12.0",
    minimalTlsVersion: "1.2",
    publicNetworkAccess: "Enabled",
  }, defaults?.server), { apiVersion: "2022-05-01-preview" });

  const database = new SqlDatabaseResource(mergeDefaults({
    name: `${name}/${dbName}`,
    location,
    tags: commonTags,
    sku: {
      name: sku,
    },
    collation: "SQL_Latin1_General_CP1_CI_AS",
    maxSizeBytes: 2147483648,
    catalogCollation: "SQL_Latin1_General_CP1_CI_AS",
    zoneRedundant: false,
  }, defaults?.database), { apiVersion: "2022-05-01-preview" });

  const firewallRule = new SqlFirewallRule(mergeDefaults({
    name: `${name}/AllowAllAzureIps`,
    startIpAddress: "0.0.0.0",
    endIpAddress: "0.0.0.0",
  }, defaults?.firewallRule), { apiVersion: "2022-05-01-preview" });

  return { server, database, firewallRule };
}, "SqlDatabase");
