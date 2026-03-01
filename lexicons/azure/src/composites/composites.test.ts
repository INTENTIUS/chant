import { describe, test, expect } from "bun:test";
import { StorageAccountSecure } from "./storage-account";
import { VnetDefault } from "./vnet-default";
import { VmLinux } from "./vm-linux";
import { AppService } from "./app-service";
import { AksCluster } from "./aks-cluster";
import { SqlDatabase } from "./sql-database";
import { KeyVaultSecure } from "./keyvault";
import { ContainerRegistrySecure } from "./container-registry";
import { FunctionApp } from "./function-app";
import { ServiceBusPipeline } from "./service-bus-pipeline";
import { CosmosDatabase } from "./cosmos-database";
import { ApplicationGateway } from "./application-gateway";
import { ContainerInstance } from "./container-instance";
import { RedisCache } from "./redis-cache";
import { PrivateEndpoint } from "./private-endpoint";

// --- StorageAccountSecure ---

describe("StorageAccountSecure", () => {
  test("returns correct resource type", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage" });
    expect(storageAccount.type).toBe("Microsoft.Storage/storageAccounts");
  });

  test("returns 1 declarable", () => {
    const result = StorageAccountSecure({ name: "mystorage" });
    expect(Object.keys(result)).toEqual(["storageAccount"]);
  });

  test("applies security defaults", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage" });
    const props = storageAccount.properties as Record<string, unknown>;
    expect(props.supportsHttpsTrafficOnly).toBe(true);
    expect(props.minimumTlsVersion).toBe("TLS1_2");
    expect(props.allowBlobPublicAccess).toBe(false);
    expect(props.encryption).toBeDefined();
  });

  test("uses default SKU and location", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage" });
    expect((storageAccount.sku as Record<string, unknown>).name).toBe("Standard_LRS");
    expect(storageAccount.location).toBe("[resourceGroup().location]");
  });

  test("accepts custom SKU", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage", sku: "Standard_GRS" });
    expect((storageAccount.sku as Record<string, unknown>).name).toBe("Standard_GRS");
  });

  test("propagates tags", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage", tags: { env: "prod" } });
    const tags = storageAccount.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });

  test("encryption covers all 4 services", () => {
    const { storageAccount } = StorageAccountSecure({ name: "mystorage" });
    const props = storageAccount.properties as Record<string, unknown>;
    const encryption = props.encryption as Record<string, unknown>;
    const services = encryption.services as Record<string, unknown>;
    expect(services.blob).toBeDefined();
    expect(services.file).toBeDefined();
    expect(services.table).toBeDefined();
    expect(services.queue).toBeDefined();
  });
});

// --- VnetDefault ---

describe("VnetDefault", () => {
  test("returns 5 resources", () => {
    const result = VnetDefault({ name: "my-vnet" });
    expect(Object.keys(result)).toEqual(["virtualNetwork", "subnet1", "subnet2", "nsg", "routeTable"]);
  });

  test("correct resource types", () => {
    const result = VnetDefault({ name: "my-vnet" });
    expect(result.virtualNetwork.type).toBe("Microsoft.Network/virtualNetworks");
    expect(result.subnet1.type).toBe("Microsoft.Network/virtualNetworks/subnets");
    expect(result.subnet2.type).toBe("Microsoft.Network/virtualNetworks/subnets");
    expect(result.nsg.type).toBe("Microsoft.Network/networkSecurityGroups");
    expect(result.routeTable.type).toBe("Microsoft.Network/routeTables");
  });

  test("uses default address prefixes", () => {
    const result = VnetDefault({ name: "my-vnet" });
    const vnetProps = result.virtualNetwork.properties as Record<string, unknown>;
    const addressSpace = vnetProps.addressSpace as Record<string, unknown>;
    expect(addressSpace.addressPrefixes).toEqual(["10.0.0.0/16"]);
  });

  test("subnets reference NSG and route table", () => {
    const result = VnetDefault({ name: "my-vnet" });
    const subnet1Props = result.subnet1.properties as Record<string, unknown>;
    expect(subnet1Props.networkSecurityGroup).toBeDefined();
    expect(subnet1Props.routeTable).toBeDefined();
  });

  test("propagates tags to all resources", () => {
    const result = VnetDefault({ name: "my-vnet", tags: { env: "prod" } });
    const vnetTags = result.virtualNetwork.tags as Record<string, string>;
    const nsgTags = result.nsg.tags as Record<string, string>;
    expect(vnetTags.env).toBe("prod");
    expect(nsgTags.env).toBe("prod");
  });

  test("accepts custom address prefixes", () => {
    const result = VnetDefault({
      name: "my-vnet",
      addressPrefix: "172.16.0.0/16",
      subnetPrefixes: ["172.16.1.0/24", "172.16.2.0/24"],
    });
    const subnet1Props = result.subnet1.properties as Record<string, unknown>;
    expect(subnet1Props.addressPrefix).toBe("172.16.1.0/24");
  });
});

// --- AppService ---

describe("AppService", () => {
  test("returns 2 resources", () => {
    const result = AppService({ name: "my-app" });
    expect(Object.keys(result)).toEqual(["plan", "webApp"]);
  });

  test("correct resource types", () => {
    const result = AppService({ name: "my-app" });
    expect(result.plan.type).toBe("Microsoft.Web/serverfarms");
    expect(result.webApp.type).toBe("Microsoft.Web/sites");
  });

  test("web app has managed identity", () => {
    const result = AppService({ name: "my-app" });
    const identity = result.webApp.identity as Record<string, unknown>;
    expect(identity.type).toBe("SystemAssigned");
  });

  test("web app has HTTPS-only and TLS 1.2", () => {
    const result = AppService({ name: "my-app" });
    const props = result.webApp.properties as Record<string, unknown>;
    expect(props.httpsOnly).toBe(true);
    const siteConfig = props.siteConfig as Record<string, unknown>;
    expect(siteConfig.minTlsVersion).toBe("1.2");
  });

  test("web app references plan via serverFarmId", () => {
    const result = AppService({ name: "my-app" });
    const props = result.webApp.properties as Record<string, unknown>;
    expect(props.serverFarmId).toContain("Microsoft.Web/serverfarms");
    expect(props.serverFarmId).toContain("my-app-plan");
  });

  test("accepts custom SKU and runtime", () => {
    const result = AppService({ name: "my-app", sku: "P1v3", runtime: "DOTNETCORE|8.0" });
    expect((result.plan.sku as Record<string, unknown>).name).toBe("P1v3");
    const siteConfig = (result.webApp.properties as Record<string, unknown>).siteConfig as Record<string, unknown>;
    expect(siteConfig.linuxFxVersion).toBe("DOTNETCORE|8.0");
  });

  test("propagates tags", () => {
    const result = AppService({ name: "my-app", tags: { env: "staging" } });
    const planTags = result.plan.tags as Record<string, string>;
    const appTags = result.webApp.tags as Record<string, string>;
    expect(planTags.env).toBe("staging");
    expect(appTags.env).toBe("staging");
  });
});

// --- AksCluster ---

describe("AksCluster", () => {
  test("returns 1 resource", () => {
    const result = AksCluster({ name: "my-aks" });
    expect(Object.keys(result)).toEqual(["cluster"]);
  });

  test("correct resource type", () => {
    const { cluster } = AksCluster({ name: "my-aks" });
    expect(cluster.type).toBe("Microsoft.ContainerService/managedClusters");
  });

  test("has managed identity", () => {
    const { cluster } = AksCluster({ name: "my-aks" });
    const identity = cluster.identity as Record<string, unknown>;
    expect(identity.type).toBe("SystemAssigned");
  });

  test("RBAC enabled by default", () => {
    const { cluster } = AksCluster({ name: "my-aks" });
    const props = cluster.properties as Record<string, unknown>;
    expect(props.enableRBAC).toBe(true);
  });

  test("uses default node count and VM size", () => {
    const { cluster } = AksCluster({ name: "my-aks" });
    const props = cluster.properties as Record<string, unknown>;
    const pools = props.agentPoolProfiles as Array<Record<string, unknown>>;
    expect(pools[0].count).toBe(3);
    expect(pools[0].vmSize).toBe("Standard_D2s_v5");
  });

  test("accepts custom node count and VM size", () => {
    const { cluster } = AksCluster({ name: "my-aks", nodeCount: 5, vmSize: "Standard_D4s_v5" });
    const props = cluster.properties as Record<string, unknown>;
    const pools = props.agentPoolProfiles as Array<Record<string, unknown>>;
    expect(pools[0].count).toBe(5);
    expect(pools[0].vmSize).toBe("Standard_D4s_v5");
  });

  test("propagates tags", () => {
    const { cluster } = AksCluster({ name: "my-aks", tags: { env: "prod" } });
    const tags = cluster.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- SqlDatabase ---

describe("SqlDatabase", () => {
  test("returns 3 resources", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass" });
    expect(Object.keys(result)).toEqual(["server", "database", "firewallRule"]);
  });

  test("correct resource types", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass" });
    expect(result.server.type).toBe("Microsoft.Sql/servers");
    expect(result.database.type).toBe("Microsoft.Sql/servers/databases");
    expect(result.firewallRule.type).toBe("Microsoft.Sql/servers/firewallRules");
  });

  test("SQL server has TLS 1.2", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass" });
    const props = result.server.properties as Record<string, unknown>;
    expect(props.minimalTlsVersion).toBe("1.2");
  });

  test("database name is derived from server name", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass" });
    expect(result.database.name).toBe("my-sql/my-sql-db");
  });

  test("firewallRule name references server", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass" });
    expect(result.firewallRule.name).toBe("my-sql/AllowAllAzureIps");
  });

  test("accepts custom SKU", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass", sku: "S1" });
    expect((result.database.sku as Record<string, unknown>).name).toBe("S1");
  });

  test("propagates tags", () => {
    const result = SqlDatabase({ name: "my-sql", adminLogin: "admin", adminPassword: "pass", tags: { env: "prod" } });
    const serverTags = result.server.tags as Record<string, string>;
    const dbTags = result.database.tags as Record<string, string>;
    expect(serverTags.env).toBe("prod");
    expect(dbTags.env).toBe("prod");
  });
});

// --- KeyVaultSecure ---

describe("KeyVaultSecure", () => {
  test("returns 1 resource", () => {
    const result = KeyVaultSecure({ name: "my-vault", tenantId: "00000000-0000-0000-0000-000000000000" });
    expect(Object.keys(result)).toEqual(["vault"]);
  });

  test("correct resource type", () => {
    const { vault } = KeyVaultSecure({ name: "my-vault", tenantId: "00000000-0000-0000-0000-000000000000" });
    expect(vault.type).toBe("Microsoft.KeyVault/vaults");
  });

  test("soft delete enabled", () => {
    const { vault } = KeyVaultSecure({ name: "my-vault", tenantId: "00000000-0000-0000-0000-000000000000" });
    const props = vault.properties as Record<string, unknown>;
    expect(props.enableSoftDelete).toBe(true);
  });

  test("purge protection enabled", () => {
    const { vault } = KeyVaultSecure({ name: "my-vault", tenantId: "00000000-0000-0000-0000-000000000000" });
    const props = vault.properties as Record<string, unknown>;
    expect(props.enablePurgeProtection).toBe(true);
  });

  test("soft delete retention is 90 days", () => {
    const { vault } = KeyVaultSecure({ name: "my-vault", tenantId: "00000000-0000-0000-0000-000000000000" });
    const props = vault.properties as Record<string, unknown>;
    expect(props.softDeleteRetentionInDays).toBe(90);
  });

  test("accepts access policies", () => {
    const { vault } = KeyVaultSecure({
      name: "my-vault",
      tenantId: "00000000-0000-0000-0000-000000000000",
      accessPolicies: [{
        tenantId: "00000000-0000-0000-0000-000000000000",
        objectId: "11111111-1111-1111-1111-111111111111",
        permissions: { secrets: ["get", "list"] },
      }],
    });
    const props = vault.properties as Record<string, unknown>;
    const policies = props.accessPolicies as unknown[];
    expect(policies).toHaveLength(1);
  });

  test("propagates tags", () => {
    const { vault } = KeyVaultSecure({
      name: "my-vault",
      tenantId: "00000000-0000-0000-0000-000000000000",
      tags: { env: "prod" },
    });
    const tags = vault.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- ContainerRegistrySecure ---

describe("ContainerRegistrySecure", () => {
  test("returns 1 resource", () => {
    const result = ContainerRegistrySecure({ name: "myacr" });
    expect(Object.keys(result)).toEqual(["registry"]);
  });

  test("correct resource type", () => {
    const { registry } = ContainerRegistrySecure({ name: "myacr" });
    expect(registry.type).toBe("Microsoft.ContainerRegistry/registries");
  });

  test("admin user disabled", () => {
    const { registry } = ContainerRegistrySecure({ name: "myacr" });
    const props = registry.properties as Record<string, unknown>;
    expect(props.adminUserEnabled).toBe(false);
  });

  test("default SKU is Premium", () => {
    const { registry } = ContainerRegistrySecure({ name: "myacr" });
    expect((registry.sku as Record<string, unknown>).name).toBe("Premium");
  });

  test("content trust enabled", () => {
    const { registry } = ContainerRegistrySecure({ name: "myacr" });
    const props = registry.properties as Record<string, unknown>;
    const policies = props.policies as Record<string, unknown>;
    const trustPolicy = policies.trustPolicy as Record<string, unknown>;
    expect(trustPolicy.status).toBe("enabled");
  });

  test("propagates tags", () => {
    const { registry } = ContainerRegistrySecure({ name: "myacr", tags: { env: "prod" } });
    const tags = registry.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- VmLinux ---

describe("VmLinux", () => {
  const minimalProps = {
    name: "my-vm",
    vmSize: "Standard_B2s",
    adminUsername: "azureuser",
    sshPublicKey: "ssh-rsa AAAA...",
    subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'my-vnet', 'subnet-1')]",
  };

  test("returns 3 resources without public IP", () => {
    const result = VmLinux(minimalProps);
    expect(Object.keys(result)).toEqual(["virtualMachine", "nic", "nsg"]);
    expect(result.publicIpAddress).toBeUndefined();
  });

  test("returns 4 resources with public IP", () => {
    const result = VmLinux({ ...minimalProps, publicIp: true });
    expect(result.publicIpAddress).toBeDefined();
  });

  test("correct resource types", () => {
    const result = VmLinux(minimalProps);
    expect(result.virtualMachine.type).toBe("Microsoft.Compute/virtualMachines");
    expect(result.nic.type).toBe("Microsoft.Network/networkInterfaces");
    expect(result.nsg.type).toBe("Microsoft.Network/networkSecurityGroups");
  });

  test("VM uses managed disk", () => {
    const result = VmLinux(minimalProps);
    const props = result.virtualMachine.properties as Record<string, unknown>;
    const storageProfile = props.storageProfile as Record<string, unknown>;
    const osDisk = storageProfile.osDisk as Record<string, unknown>;
    expect(osDisk.managedDisk).toBeDefined();
  });

  test("NIC references NSG", () => {
    const result = VmLinux(minimalProps);
    const nicProps = result.nic.properties as Record<string, unknown>;
    expect(nicProps.networkSecurityGroup).toBeDefined();
  });

  test("SSH key authentication configured", () => {
    const result = VmLinux(minimalProps);
    const props = result.virtualMachine.properties as Record<string, unknown>;
    const osProfile = props.osProfile as Record<string, unknown>;
    const linuxConfig = osProfile.linuxConfiguration as Record<string, unknown>;
    expect(linuxConfig.disablePasswordAuthentication).toBe(true);
  });

  test("propagates tags to all resources", () => {
    const result = VmLinux({ ...minimalProps, tags: { env: "prod" } });
    const vmTags = result.virtualMachine.tags as Record<string, string>;
    const nicTags = result.nic.tags as Record<string, string>;
    const nsgTags = result.nsg.tags as Record<string, string>;
    expect(vmTags.env).toBe("prod");
    expect(nicTags.env).toBe("prod");
    expect(nsgTags.env).toBe("prod");
  });
});

// --- FunctionApp ---

describe("FunctionApp", () => {
  test("returns 3 resources", () => {
    const result = FunctionApp({ name: "my-func" });
    expect(Object.keys(result)).toEqual(["plan", "functionApp", "storageAccount"]);
  });

  test("correct resource types", () => {
    const result = FunctionApp({ name: "my-func" });
    expect(result.plan.type).toBe("Microsoft.Web/serverfarms");
    expect(result.functionApp.type).toBe("Microsoft.Web/sites");
    expect(result.storageAccount.type).toBe("Microsoft.Storage/storageAccounts");
  });

  test("function app has SystemAssigned identity", () => {
    const result = FunctionApp({ name: "my-func" });
    const identity = result.functionApp.identity as Record<string, unknown>;
    expect(identity.type).toBe("SystemAssigned");
  });

  test("security defaults: HTTPS-only, TLS 1.2, FTPS disabled", () => {
    const result = FunctionApp({ name: "my-func" });
    const props = result.functionApp.properties as Record<string, unknown>;
    expect(props.httpsOnly).toBe(true);
    const siteConfig = props.siteConfig as Record<string, unknown>;
    expect(siteConfig.minTlsVersion).toBe("1.2");
    expect(siteConfig.ftpsState).toBe("Disabled");
  });

  test("plan uses Y1 consumption SKU", () => {
    const result = FunctionApp({ name: "my-func" });
    const sku = result.plan.sku as Record<string, unknown>;
    expect(sku.name).toBe("Y1");
    expect(sku.tier).toBe("Dynamic");
  });

  test("propagates tags", () => {
    const result = FunctionApp({ name: "my-func", tags: { env: "prod" } });
    const planTags = result.plan.tags as Record<string, string>;
    const appTags = result.functionApp.tags as Record<string, string>;
    const storageTags = result.storageAccount.tags as Record<string, string>;
    expect(planTags.env).toBe("prod");
    expect(appTags.env).toBe("prod");
    expect(storageTags.env).toBe("prod");
    expect(planTags["managed-by"]).toBe("chant");
  });

  test("accepts custom runtime", () => {
    const result = FunctionApp({ name: "my-func", runtime: "python" });
    const props = result.functionApp.properties as Record<string, unknown>;
    const siteConfig = props.siteConfig as Record<string, unknown>;
    const appSettings = siteConfig.appSettings as Array<Record<string, unknown>>;
    const workerRuntime = appSettings.find((s) => s.name === "FUNCTIONS_WORKER_RUNTIME");
    expect(workerRuntime?.value).toBe("python");
  });
});

// --- ServiceBusPipeline ---

describe("ServiceBusPipeline", () => {
  test("returns namespace and queue by default", () => {
    const result = ServiceBusPipeline({ name: "my-sb" });
    expect(result.namespace).toBeDefined();
    expect(result.queue).toBeDefined();
    expect(result.topic).toBeUndefined();
    expect(result.subscription).toBeUndefined();
  });

  test("returns namespace, topic, and subscription when useTopic", () => {
    const result = ServiceBusPipeline({ name: "my-sb", useTopic: true });
    expect(result.namespace).toBeDefined();
    expect(result.topic).toBeDefined();
    expect(result.subscription).toBeDefined();
    expect(result.queue).toBeUndefined();
  });

  test("correct resource types", () => {
    const result = ServiceBusPipeline({ name: "my-sb" });
    expect(result.namespace.type).toBe("Microsoft.ServiceBus/namespaces");
    expect(result.queue!.type).toBe("Microsoft.ServiceBus/namespaces/queues");
  });

  test("security defaults: TLS 1.2, Standard SKU", () => {
    const result = ServiceBusPipeline({ name: "my-sb" });
    const props = result.namespace.properties as Record<string, unknown>;
    expect(props.minimumTlsVersion).toBe("1.2");
    const sku = result.namespace.sku as Record<string, unknown>;
    expect(sku.name).toBe("Standard");
  });

  test("propagates tags to namespace", () => {
    const result = ServiceBusPipeline({ name: "my-sb", tags: { env: "prod" } });
    const tags = result.namespace.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- CosmosDatabase ---

describe("CosmosDatabase", () => {
  test("returns 3 resources", () => {
    const result = CosmosDatabase({ name: "my-cosmos" });
    expect(Object.keys(result)).toEqual(["account", "database", "container"]);
  });

  test("correct resource types", () => {
    const result = CosmosDatabase({ name: "my-cosmos" });
    expect(result.account.type).toBe("Microsoft.DocumentDB/databaseAccounts");
    expect(result.database.type).toBe("Microsoft.DocumentDB/databaseAccounts/sqlDatabases");
    expect(result.container.type).toBe("Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers");
  });

  test("security defaults: automatic failover, network ACL deny, TLS 1.2", () => {
    const result = CosmosDatabase({ name: "my-cosmos" });
    const props = result.account.properties as Record<string, unknown>;
    expect(props.enableAutomaticFailover).toBe(true);
    expect(props.publicNetworkAccess).toBe("Disabled");
    expect(props.minimalTlsVersion).toBe("Tls12");
  });

  test("container has partition key", () => {
    const result = CosmosDatabase({ name: "my-cosmos", partitionKeyPath: "/tenantId" });
    const props = result.container.properties as Record<string, unknown>;
    const resource = props.resource as Record<string, unknown>;
    const partitionKey = resource.partitionKey as Record<string, unknown>;
    expect((partitionKey.paths as string[])[0]).toBe("/tenantId");
  });

  test("propagates tags", () => {
    const result = CosmosDatabase({ name: "my-cosmos", tags: { env: "prod" } });
    const tags = result.account.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- ApplicationGateway ---

describe("ApplicationGateway", () => {
  test("returns 2 resources", () => {
    const result = ApplicationGateway({ name: "my-appgw" });
    expect(Object.keys(result)).toEqual(["publicIp", "gateway"]);
  });

  test("correct resource types", () => {
    const result = ApplicationGateway({ name: "my-appgw" });
    expect(result.publicIp.type).toBe("Microsoft.Network/publicIPAddresses");
    expect(result.gateway.type).toBe("Microsoft.Network/applicationGateways");
  });

  test("security defaults: WAF_v2, TLS 1.2 policy", () => {
    const result = ApplicationGateway({ name: "my-appgw" });
    const props = result.gateway.properties as Record<string, unknown>;
    const sku = props.sku as Record<string, unknown>;
    expect(sku.name).toBe("WAF_v2");
    const sslPolicy = props.sslPolicy as Record<string, unknown>;
    expect(sslPolicy.minProtocolVersion).toBe("TLSv1_2");
  });

  test("propagates tags", () => {
    const result = ApplicationGateway({ name: "my-appgw", tags: { env: "prod" } });
    const pipTags = result.publicIp.tags as Record<string, string>;
    const gwTags = result.gateway.tags as Record<string, string>;
    expect(pipTags.env).toBe("prod");
    expect(gwTags.env).toBe("prod");
    expect(pipTags["managed-by"]).toBe("chant");
  });

  test("accepts custom SKU", () => {
    const result = ApplicationGateway({ name: "my-appgw", sku: "Standard_v2" });
    const props = result.gateway.properties as Record<string, unknown>;
    const sku = props.sku as Record<string, unknown>;
    expect(sku.name).toBe("Standard_v2");
  });
});

// --- ContainerInstance ---

describe("ContainerInstance", () => {
  test("returns 1 resource", () => {
    const result = ContainerInstance({ name: "my-ci" });
    expect(Object.keys(result)).toEqual(["containerGroup"]);
  });

  test("correct resource type", () => {
    const { containerGroup } = ContainerInstance({ name: "my-ci" });
    expect(containerGroup.type).toBe("Microsoft.ContainerInstance/containerGroups");
  });

  test("has managed identity", () => {
    const { containerGroup } = ContainerInstance({ name: "my-ci" });
    const identity = containerGroup.identity as Record<string, unknown>;
    expect(identity.type).toBe("SystemAssigned");
  });

  test("no public IP by default", () => {
    const { containerGroup } = ContainerInstance({ name: "my-ci" });
    const props = containerGroup.properties as Record<string, unknown>;
    const ipAddress = props.ipAddress as Record<string, unknown>;
    expect(ipAddress.type).toBe("Private");
  });

  test("public IP when requested", () => {
    const { containerGroup } = ContainerInstance({ name: "my-ci", publicIp: true });
    const props = containerGroup.properties as Record<string, unknown>;
    const ipAddress = props.ipAddress as Record<string, unknown>;
    expect(ipAddress.type).toBe("Public");
  });

  test("propagates tags", () => {
    const { containerGroup } = ContainerInstance({ name: "my-ci", tags: { env: "prod" } });
    const tags = containerGroup.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- RedisCache ---

describe("RedisCache", () => {
  test("returns 1 resource", () => {
    const result = RedisCache({ name: "my-redis" });
    expect(Object.keys(result)).toEqual(["redisCache"]);
  });

  test("correct resource type", () => {
    const { redisCache } = RedisCache({ name: "my-redis" });
    expect(redisCache.type).toBe("Microsoft.Cache/redis");
  });

  test("security defaults: non-SSL port disabled, TLS 1.2", () => {
    const { redisCache } = RedisCache({ name: "my-redis" });
    const props = redisCache.properties as Record<string, unknown>;
    expect(props.enableNonSslPort).toBe(false);
    expect(props.minimumTlsVersion).toBe("1.2");
  });

  test("default SKU is Standard", () => {
    const { redisCache } = RedisCache({ name: "my-redis" });
    const props = redisCache.properties as Record<string, unknown>;
    const sku = props.sku as Record<string, unknown>;
    expect(sku.name).toBe("Standard");
  });

  test("accepts custom SKU", () => {
    const { redisCache } = RedisCache({ name: "my-redis", sku: "Premium", family: "P", capacity: 2 });
    const props = redisCache.properties as Record<string, unknown>;
    const sku = props.sku as Record<string, unknown>;
    expect(sku.name).toBe("Premium");
    expect(sku.family).toBe("P");
    expect(sku.capacity).toBe(2);
  });

  test("propagates tags", () => {
    const { redisCache } = RedisCache({ name: "my-redis", tags: { env: "prod" } });
    const tags = redisCache.tags as Record<string, string>;
    expect(tags.env).toBe("prod");
    expect(tags["managed-by"]).toBe("chant");
  });
});

// --- PrivateEndpoint ---

describe("PrivateEndpoint", () => {
  const minimalProps = {
    name: "my-pe",
    targetResourceId: "[resourceId('Microsoft.Storage/storageAccounts', 'mystorage')]",
    groupId: "blob",
    subnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'pe-subnet')]",
    privateDnsZoneName: "privatelink.blob.core.windows.net",
    vnetId: "[resourceId('Microsoft.Network/virtualNetworks', 'vnet')]",
  };

  test("returns 4 resources", () => {
    const result = PrivateEndpoint(minimalProps);
    expect(Object.keys(result)).toEqual(["privateEndpoint", "privateDnsZone", "dnsZoneGroup", "vnetLink"]);
  });

  test("correct resource types", () => {
    const result = PrivateEndpoint(minimalProps);
    expect(result.privateEndpoint.type).toBe("Microsoft.Network/privateEndpoints");
    expect(result.privateDnsZone.type).toBe("Microsoft.Network/privateDnsZones");
    expect(result.dnsZoneGroup.type).toBe("Microsoft.Network/privateEndpoints/privateDnsZoneGroups");
    expect(result.vnetLink.type).toBe("Microsoft.Network/privateDnsZones/virtualNetworkLinks");
  });

  test("private endpoint references target and subnet", () => {
    const result = PrivateEndpoint(minimalProps);
    const props = result.privateEndpoint.properties as Record<string, unknown>;
    const subnet = props.subnet as Record<string, unknown>;
    expect(subnet.id).toContain("pe-subnet");
    const connections = props.privateLinkServiceConnections as Array<Record<string, unknown>>;
    const connProps = connections[0].properties as Record<string, unknown>;
    expect(connProps.groupIds).toEqual(["blob"]);
  });

  test("DNS zone is global", () => {
    const result = PrivateEndpoint(minimalProps);
    expect(result.privateDnsZone.location).toBe("global");
  });

  test("propagates tags", () => {
    const result = PrivateEndpoint({ ...minimalProps, tags: { env: "prod" } });
    const peTags = result.privateEndpoint.tags as Record<string, string>;
    const dnsTags = result.privateDnsZone.tags as Record<string, string>;
    expect(peTags.env).toBe("prod");
    expect(dnsTags.env).toBe("prod");
    expect(peTags["managed-by"]).toBe("chant");
  });
});
