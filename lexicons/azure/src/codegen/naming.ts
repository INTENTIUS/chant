/**
 * Azure-specific naming configuration for the core NamingStrategy.
 *
 * The algorithm lives in core; only the data tables and helper functions
 * for extracting names from Azure resource types are defined here.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

import type { ArmSchemaParseResult } from "../spec/parse";
import { armShortName, armServiceName } from "../spec/parse";

/**
 * Fixed TypeScript class names for core Azure resources.
 */
const priorityNames: Record<string, string> = {
  "Microsoft.Storage/storageAccounts": "StorageAccount",
  "Microsoft.Compute/virtualMachines": "VirtualMachine",
  "Microsoft.Network/virtualNetworks": "VirtualNetwork",
  "Microsoft.Network/networkSecurityGroups": "NetworkSecurityGroup",
  "Microsoft.Network/publicIPAddresses": "PublicIpAddress",
  "Microsoft.Network/networkInterfaces": "NetworkInterface",
  "Microsoft.Network/loadBalancers": "LoadBalancer",
  "Microsoft.Network/routeTables": "RouteTable",
  "Microsoft.Web/serverfarms": "AppServicePlan",
  "Microsoft.Web/sites": "WebApp",
  "Microsoft.Sql/servers": "SqlServer",
  "Microsoft.Sql/servers/databases": "SqlDatabase",
  "Microsoft.Sql/servers/firewallRules": "SqlFirewallRule",
  "Microsoft.KeyVault/vaults": "KeyVault",
  "Microsoft.ContainerService/managedClusters": "ManagedCluster",
  "Microsoft.ContainerRegistry/registries": "ContainerRegistry",
  "Microsoft.DocumentDB/databaseAccounts": "CosmosDbAccount",
  "Microsoft.Compute/disks": "ManagedDisk",
  "Microsoft.Compute/availabilitySets": "AvailabilitySet",
  "Microsoft.Network/applicationGateways": "ApplicationGateway",
  "Microsoft.Network/privateDnsZones": "PrivateDnsZone",
  "Microsoft.Network/dnsZones": "DnsZone",
  "Microsoft.ManagedIdentity/userAssignedIdentities": "UserAssignedIdentity",
  "Microsoft.Authorization/roleAssignments": "RoleAssignment",
  "Microsoft.Authorization/roleDefinitions": "RoleDefinition",
  "Microsoft.Insights/diagnosticSettings": "DiagnosticSetting",
  "Microsoft.Insights/components": "AppInsights",
  "Microsoft.OperationalInsights/workspaces": "LogAnalyticsWorkspace",
  "Microsoft.EventHub/namespaces": "EventHubNamespace",
  "Microsoft.ServiceBus/namespaces": "ServiceBusNamespace",
  "Microsoft.Cache/redis": "RedisCache",
  "Microsoft.Cdn/profiles": "CdnProfile",
  "Microsoft.SignalRService/signalR": "SignalR",
  "Microsoft.Storage/storageAccounts/blobServices/containers": "BlobContainer",
  "Microsoft.Network/virtualNetworks/subnets": "Subnet",
  "Microsoft.Resources/deployments": "Deployment",
};

/**
 * Additional TypeScript names beyond the primary priority name.
 */
const priorityAliases: Record<string, string[]> = {
  "Microsoft.Web/sites": ["AppService"],
  "Microsoft.ContainerService/managedClusters": ["AksCluster"],
  "Microsoft.DocumentDB/databaseAccounts": ["CosmosDb"],
};

/**
 * Property type aliases for backward compatibility.
 */
const priorityPropertyAliases: Record<string, Record<string, string>> = {
  "Microsoft.Storage/storageAccounts": {
    Encryption: "StorageEncryption",
    NetworkRuleSet: "StorageNetworkRules",
  },
  "Microsoft.Compute/virtualMachines": {
    HardwareProfile: "HardwareProfile",
    StorageProfile: "StorageProfile",
    OsProfile: "OsProfile",
    NetworkProfile: "NetworkProfile",
  },
};

/**
 * Service name abbreviations for collision-resolved names.
 */
const serviceAbbreviations: Record<string, string> = {
  ContainerService: "Aks",
  ContainerRegistry: "Acr",
  OperationalInsights: "Oi",
  ManagedIdentity: "Mi",
  Authorization: "Auth",
  DocumentDB: "Cosmos",
  SignalRService: "Sr",
  ServiceBus: "Sb",
  EventHub: "Eh",
  Insights: "Ai",
};

const azureNamingConfig: NamingConfig = {
  priorityNames,
  priorityAliases,
  priorityPropertyAliases,
  serviceAbbreviations,
  shortName: armShortName,
  serviceName: armServiceName,
};

/**
 * Azure-specific NamingStrategy — wraps the core algorithm with Azure data tables.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: ArmSchemaParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, azureNamingConfig);
  }
}
