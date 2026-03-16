---
skill: chant-azure-patterns
description: Advanced Azure ARM template patterns
user-invocable: true
---

# Advanced Azure ARM Patterns with Chant

## Overview

Advanced patterns for Azure ARM template generation with chant, covering
linked deployments, conditional resources, cross-resource references,
tagging strategies, multi-region patterns, and composite usage.

## Linked Template Deployments

Use `ChildProjectInstance` for linked template deployments. This deploys
a nested ARM template as a separate deployment:

```ts
import { ChildProjectInstance } from "@intentius/chant";

export const networkDeploy = new ChildProjectInstance({
  project: "../network",
  parameters: {
    vnetName: "my-vnet",
    addressPrefix: "10.0.0.0/16",
  },
});
```

## Conditional Resources with If()

Use the `If()` intrinsic for conditional resource properties:

```ts
import { If } from "@intentius/chant-lexicon-azure";

export const storage = new StorageAccount({
  name: "mystorage",
  sku: {
    name: If("isProduction", "Standard_GRS", "Standard_LRS"),
  },
});
```

## Cross-Resource References

### ResourceId()
Generate a resource ID for referencing another resource:

```ts
import { ResourceId } from "@intentius/chant-lexicon-azure";

const subnetId = ResourceId(
  "Microsoft.Network/virtualNetworks/subnets",
  "my-vnet",
  "subnet-1",
);
```

### Reference()
Get the runtime state of a deployed resource:

```ts
import { Reference } from "@intentius/chant-lexicon-azure";

const storageKeys = Reference("myStorage", "2023-01-01");
// Use in properties: storageKeys.primaryEndpoints.blob
```

### Concat()
Build dynamic strings:

```ts
import { Concat, UniqueString } from "@intentius/chant-lexicon-azure";

const uniqueName = Concat("storage", UniqueString("my-seed"));
```

## Tagging Strategies

### Default Tags
Apply project-wide tags to all taggable resources:

```ts
import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-app" },
  { key: "Environment", value: "production" },
  { key: "ManagedBy", value: "chant" },
  { key: "CostCenter", value: "engineering" },
]);
```

### Per-Resource Tags
Override or extend default tags on specific resources:

```ts
export const storage = new StorageAccount({
  tags: {
    DataClassification: "confidential",
    RetentionPolicy: "7-years",
  },
});
```

Tag merge behavior: resource-level tags take precedence over default tags
when the same key exists in both.

## Multi-Region Deployments

### Parameterized Location
Use pseudo-parameters for the primary region and parameters for secondary:

```ts
import { Azure } from "@intentius/chant-lexicon-azure";
import { CoreParameter } from "@intentius/chant";

export const secondaryRegion = new CoreParameter({
  name: "secondaryRegion",
  type: "string",
  default: "westus2",
});

export const primaryStorage = new StorageAccount({
  name: "primary-storage",
  location: Azure.ResourceGroupLocation,
});

export const secondaryStorage = new StorageAccount({
  name: "secondary-storage",
  location: secondaryRegion,
});
```

## Parameters and Outputs

### CoreParameter → ARM Parameters
Parameters become ARM template parameters with type and default:

```ts
import { CoreParameter } from "@intentius/chant";

export const environment = new CoreParameter({
  name: "environment",
  type: "string",
  allowedValues: ["dev", "staging", "production"],
  default: "dev",
});
```

### StackOutput → ARM Outputs
Outputs become ARM template outputs:

```ts
import { StackOutput } from "@intentius/chant";
import { Reference } from "@intentius/chant-lexicon-azure";

export const storageEndpoint = new StackOutput({
  name: "storageEndpoint",
  value: Reference("myStorage").primaryEndpoints.blob,
});
```

## Composite Usage Patterns

### StorageAccountSecure
Secure storage with encryption, HTTPS, and network isolation:

```ts
import { StorageAccountSecure } from "@intentius/chant-lexicon-azure";

const { storageAccount } = StorageAccountSecure({
  name: "myappstorage",
  sku: "Standard_GRS",
  tags: { environment: "production" },
});

export { storageAccount };
```

### VnetDefault
Standard VNet with two subnets, NSG, and route table:

```ts
import { VnetDefault } from "@intentius/chant-lexicon-azure";

const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "my-vnet",
  addressPrefix: "10.0.0.0/16",
  subnetPrefixes: ["10.0.1.0/24", "10.0.2.0/24"],
});

export { virtualNetwork, subnet1, subnet2, nsg, routeTable };
```

### AppService
App Service Plan + Web App with managed identity and HTTPS:

```ts
import { AppService } from "@intentius/chant-lexicon-azure";

const { plan, webApp } = AppService({
  name: "my-web-app",
  sku: "P1v3",
  runtime: "DOTNETCORE|8.0",
});

export { plan, webApp };
```

### AksCluster
AKS cluster with node pool, RBAC, and managed identity:

```ts
import { AksCluster } from "@intentius/chant-lexicon-azure";

const { cluster } = AksCluster({
  name: "my-aks",
  nodeCount: 5,
  vmSize: "Standard_D4s_v5",
  kubernetesVersion: "1.29",
});

export { cluster };
```

### SqlDatabase
SQL Server + Database + Firewall Rule:

```ts
import { SqlDatabase } from "@intentius/chant-lexicon-azure";

const { server, database, firewallRule } = SqlDatabase({
  name: "my-sql",
  adminLogin: "sqladmin",
  adminPassword: "P@ssw0rd!",
  sku: "S1",
});

export { server, database, firewallRule };
```

### KeyVaultSecure
Key Vault with soft delete and purge protection:

```ts
import { KeyVaultSecure } from "@intentius/chant-lexicon-azure";

const { vault } = KeyVaultSecure({
  name: "my-vault",
  tenantId: Azure.TenantId,
});

export { vault };
```

### ContainerRegistrySecure
ACR with admin disabled and content trust:

```ts
import { ContainerRegistrySecure } from "@intentius/chant-lexicon-azure";

const { registry } = ContainerRegistrySecure({
  name: "myacr01",
  sku: "Premium",
});

export { registry };
```

### VmLinux
Linux VM with NIC, NSG, and optional public IP:

```ts
import { VmLinux, VnetDefault } from "@intentius/chant-lexicon-azure";

const vnet = VnetDefault({ name: "my-vnet" });

const { virtualMachine, nic, nsg } = VmLinux({
  name: "my-vm",
  vmSize: "Standard_B2s",
  adminUsername: "azureuser",
  sshPublicKey: "ssh-rsa AAAA...",
  subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'my-vnet', 'subnet-1')]",
});

export { virtualMachine, nic, nsg };
```

### FunctionApp
Consumption Function App with storage, managed identity, and HTTPS:

```ts
import { FunctionApp } from "@intentius/chant-lexicon-azure";

const { plan, functionApp, storageAccount } = FunctionApp({
  name: "my-func",
  runtime: "node",
  runtimeVersion: "~4",
  tags: { environment: "production" },
});

export { plan, functionApp, storageAccount };
```

### ServiceBusPipeline
ServiceBus Namespace with Queue or Topic:

```ts
import { ServiceBusPipeline } from "@intentius/chant-lexicon-azure";

// Queue mode (default)
const { namespace, queue } = ServiceBusPipeline({ name: "my-sb" });

// Topic mode
const { namespace: ns, topic, subscription } = ServiceBusPipeline({
  name: "my-sb",
  useTopic: true,
});

export { namespace, queue };
```

### CosmosDatabase
Cosmos DB Account + SQL Database + Container with failover and TLS:

```ts
import { CosmosDatabase } from "@intentius/chant-lexicon-azure";

const { account, database, container } = CosmosDatabase({
  name: "my-cosmos",
  databaseName: "app-db",
  containerName: "items",
  partitionKeyPath: "/tenantId",
});

export { account, database, container };
```

### ApplicationGateway
Application Gateway + Public IP with WAF and TLS 1.2:

```ts
import { ApplicationGateway } from "@intentius/chant-lexicon-azure";

const { publicIp, gateway } = ApplicationGateway({
  name: "my-appgw",
  sku: "WAF_v2",
  subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'appgw-subnet')]",
});

export { publicIp, gateway };
```

### ContainerInstance
Container Group with managed identity:

```ts
import { ContainerInstance } from "@intentius/chant-lexicon-azure";

const { containerGroup } = ContainerInstance({
  name: "my-ci",
  image: "mcr.microsoft.com/azuredocs/aci-helloworld",
  cpu: 2,
  memoryInGb: 4,
  publicIp: true,
});

export { containerGroup };
```

### RedisCache
Azure Cache for Redis with TLS 1.2 and SSL-only:

```ts
import { RedisCache } from "@intentius/chant-lexicon-azure";

const { redisCache } = RedisCache({
  name: "my-redis",
  sku: "Premium",
  family: "P",
  capacity: 1,
});

export { redisCache };
```

### PrivateEndpoint
Private Endpoint + DNS Zone for private connectivity:

```ts
import { PrivateEndpoint, StorageAccountSecure } from "@intentius/chant-lexicon-azure";

const { storageAccount } = StorageAccountSecure({ name: "mystorage" });

const { privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink } = PrivateEndpoint({
  name: "storage-pe",
  targetResourceId: "[resourceId('Microsoft.Storage/storageAccounts', 'mystorage')]",
  groupId: "blob",
  subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'pe-subnet')]",
  privateDnsZoneName: "privatelink.blob.core.windows.net",
  vnetId: "[resourceId('Microsoft.Network/virtualNetworks', 'vnet')]",
});

export { storageAccount, privateEndpoint, privateDnsZone, dnsZoneGroup, vnetLink };
```

## ARM Template Intrinsic Reference

| Function | Description | Example |
|----------|-------------|---------|
| `ResourceId(type, ...names)` | Generate resource ID | `ResourceId("Microsoft.Storage/storageAccounts", "myStorage")` |
| `Reference(name, apiVersion?)` | Get runtime resource state | `Reference("myStorage", "2023-01-01")` |
| `Concat(...values)` | Concatenate strings | `Concat("prefix-", "suffix")` |
| `ResourceGroup()` | Get resource group object | `ResourceGroup().location` |
| `Subscription()` | Get subscription object | `Subscription().subscriptionId` |
| `UniqueString(...seeds)` | Deterministic hash | `UniqueString("my-seed")` |
| `Format(fmt, ...args)` | Format string | `Format("{0}-{1}", "a", "b")` |
| `If(condition, true, false)` | Conditional | `If("isProduction", "GRS", "LRS")` |
| `ListKeys(resourceId, apiVersion)` | List access keys | `ListKeys(ResourceId(...), "2023-01-01")` |

## Pseudo-Parameters

| Parameter | Description |
|-----------|-------------|
| `Azure.ResourceGroupName` | Current resource group name |
| `Azure.ResourceGroupLocation` | Current resource group location |
| `Azure.ResourceGroupId` | Current resource group ID |
| `Azure.SubscriptionId` | Current subscription ID |
| `Azure.TenantId` | Current Azure AD tenant ID |
| `Azure.DeploymentName` | Current deployment name |
