---
skill: chant-azure-security
description: Azure security best practices for infrastructure
user-invocable: true
---

# Azure Security Best Practices for Chant

## Overview

Security patterns and best practices for Azure ARM templates generated with chant.
These patterns map directly to the post-synth checks (AZR016–AZR029) and help AI agents
produce secure-by-default infrastructure.

## Identity & Access

### Managed Identity over Keys
Always use managed identity instead of storing credentials in code or configuration:

```ts
const webApp = new WebApp({
  name: "my-app",
  identity: { type: "SystemAssigned" },
  // ...
});
```

### RBAC for AKS
Enable RBAC on AKS clusters for fine-grained access control:

```ts
const cluster = new ManagedCluster({
  name: "my-aks",
  properties: {
    enableRBAC: true,
  },
});
```

### Container Registry — Disable Admin
Never enable the admin user on Azure Container Registry.
Use Azure AD authentication or service principals instead:

```ts
const registry = new ContainerRegistry({
  name: "myacr",
  properties: {
    adminUserEnabled: false,
  },
});
```

## Encryption

### Key Vault — Soft Delete & Purge Protection
Always enable soft delete and purge protection on Key Vault
to protect against accidental or malicious deletion:

```ts
const vault = new KeyVault({
  name: "my-vault",
  properties: {
    enableSoftDelete: true,
    softDeleteRetentionInDays: 90,
    enablePurgeProtection: true,
  },
});
```

### Storage Account Encryption
Enable encryption on all storage services (blob, file, table, queue):

```ts
const storage = new StorageAccount({
  properties: {
    encryption: {
      services: {
        blob: { enabled: true },
        file: { enabled: true },
        table: { enabled: true },
        queue: { enabled: true },
      },
      keySource: "Microsoft.Storage",
    },
  },
});
```

### Managed Disk Encryption
Configure encryption on all managed disks:

```ts
const disk = new Disk({
  properties: {
    encryption: {
      type: "EncryptionAtRestWithPlatformKey",
    },
  },
});
```

### SQL Server TDE
Add Transparent Data Encryption (TDE) to SQL databases:

```ts
// Add a TDE resource alongside the database
const tde = new SqlTransparentDataEncryption({
  name: `${serverName}/${dbName}/current`,
  properties: {
    status: "Enabled",
  },
});
```

## Network Security

### NSG on Network Interfaces
Always associate an NSG with network interfaces to control traffic:

```ts
const nic = new NetworkInterface({
  properties: {
    networkSecurityGroup: {
      id: "[resourceId('Microsoft.Network/networkSecurityGroups', 'my-nsg')]",
    },
  },
});
```

### AKS Network Policy
Configure network policy on AKS clusters for pod-to-pod traffic control:

```ts
const cluster = new ManagedCluster({
  properties: {
    networkProfile: {
      networkPlugin: "azure",
      networkPolicy: "azure", // or "calico"
    },
  },
});
```

### Storage — Disable Public Blob Access
Disable public blob access on storage accounts:

```ts
const storage = new StorageAccount({
  properties: {
    allowBlobPublicAccess: false,
  },
});
```

## Transport Security

### HTTPS-Only on App Service
Enforce HTTPS-only traffic on all web applications:

```ts
const webApp = new WebApp({
  properties: {
    httpsOnly: true,
  },
});
```

### Minimum TLS 1.2
Set minimum TLS version to 1.2 on App Services and SQL Servers:

```ts
const webApp = new WebApp({
  properties: {
    siteConfig: {
      minTlsVersion: "1.2",
    },
  },
});
```

### SQL Server Minimum TLS
```ts
const server = new SqlServer({
  properties: {
    minimalTlsVersion: "1.2",
  },
});
```

## Diagnostics & Auditing

### VM Boot Diagnostics
Enable boot diagnostics on virtual machines:

```ts
const vm = new VirtualMachine({
  properties: {
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true,
      },
    },
  },
});
```

### SQL Server Auditing
Configure auditing on SQL servers:

```ts
const auditSettings = new SqlAuditingSettings({
  name: `${serverName}/default`,
  properties: {
    state: "Enabled",
    retentionDays: 90,
  },
});
```

### VM Managed Disks
Always use managed disks instead of unmanaged (VHD-based) disks:

```ts
const vm = new VirtualMachine({
  properties: {
    storageProfile: {
      osDisk: {
        createOption: "FromImage",
        managedDisk: {
          storageAccountType: "Premium_LRS",
        },
      },
    },
  },
});
```

## RBAC Role Constants

Use built-in role name constants for type-safe role assignments:

```ts
import {
  StorageRoles, ComputeRoles, NetworkRoles, KeyVaultRoles,
  SqlRoles, ContainerRoles, AppServiceRoles, IdentityRoles,
} from "@intentius/chant-lexicon-azure";

// Examples:
StorageRoles.BlobDataContributor   // "Storage Blob Data Contributor"
KeyVaultRoles.SecretsOfficer       // "Key Vault Secrets Officer"
ContainerRoles.AcrPull             // "AcrPull"
IdentityRoles.ManagedIdentityOperator // "Managed Identity Operator"
```

## Composites with Security Defaults

Use the secure composite variants which apply these patterns automatically:

- `StorageAccountSecure` — HTTPS-only, encryption, TLS 1.2, no public blob access
- `KeyVaultSecure` — Soft delete, purge protection enabled
- `ContainerRegistrySecure` — Admin disabled, content trust enabled
- `AppService` — Managed identity, HTTPS-only, TLS 1.2, FTPS disabled
- `FunctionApp` — SystemAssigned identity, HTTPS-only, TLS 1.2, FTPS disabled
- `ServiceBusPipeline` — TLS 1.2, Standard SKU
- `CosmosDatabase` — Automatic failover, network ACL deny, TLS 1.2
- `ApplicationGateway` — WAF_v2 SKU, TLS 1.2 policy
- `ContainerInstance` — Managed identity, no public IP by default
- `RedisCache` — Non-SSL port disabled, TLS 1.2
- `PrivateEndpoint` — Private connectivity pattern with DNS zone

## Post-Synth Check Reference

| Check | Description |
|-------|-------------|
| AZR014 | Public blob access enabled on storage account |
| AZR015 | Missing encryption on storage account |
| AZR016 | Key Vault soft-delete not enabled |
| AZR017 | Key Vault purge protection not enabled |
| AZR018 | SQL Server missing auditing |
| AZR019 | SQL Server missing TDE |
| AZR020 | App Service missing managed identity |
| AZR021 | App Service missing HTTPS-only |
| AZR022 | App Service missing minimum TLS 1.2 |
| AZR023 | VM missing managed disk |
| AZR024 | VM missing boot diagnostics |
| AZR025 | AKS missing RBAC |
| AZR026 | AKS missing network policy |
| AZR027 | Container Registry admin enabled |
| AZR028 | Network interface missing NSG |
| AZR029 | Disk missing encryption |
