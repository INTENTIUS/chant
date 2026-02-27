import { describe, test, expect } from "bun:test";
import { StorageAccountSecure } from "./storage-account";
import { VnetDefault } from "./vnet-default";
import { VmLinux } from "./vm-linux";
import { AppService } from "./app-service";
import { AksCluster } from "./aks-cluster";
import { SqlDatabase } from "./sql-database";
import { KeyVaultSecure } from "./keyvault";
import { ContainerRegistrySecure } from "./container-registry";

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
