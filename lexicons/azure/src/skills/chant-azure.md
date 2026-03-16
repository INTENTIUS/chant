---
skill: chant-azure
description: Azure Resource Manager infrastructure generation with chant
user-invocable: true
---

# Azure ARM Template Operational Playbook

## How chant and ARM relate

chant is a **synthesis compiler** — it compiles TypeScript source files into ARM template JSON. `chant build` does not call Azure APIs; synthesis is pure and deterministic. The output is a standard ARM template (`dist/template.json`) that you deploy via the Azure CLI, PowerShell, or any ARM-compatible pipeline. Your job as an agent is to bridge synthesis and deployment:

- Use **chant** for: build, lint, diff (local template comparison)
- Use **az** CLI for: deploy, validate, what-if, rollback, monitoring

The source of truth for infrastructure is the TypeScript in `src/`. The generated ARM template is an intermediate artifact.

## Installation

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-azure
```

## Build and validate workflow

### 1. Lint the source

```bash
chant lint src/
```

Runs pre-synth static analysis on your TypeScript. Fix all warnings before building.

### 2. Build the ARM template

```bash
chant build src/ --output dist/template.json
```

Synthesizes TypeScript into ARM JSON and runs post-synth checks on the output.

### 3. Validate against Azure

```bash
az deployment group validate \
  --resource-group my-rg \
  --template-file dist/template.json
```

Sends the template to Azure for server-side validation without deploying. Catches quota issues, naming conflicts, and API version mismatches.

### 4. Preview changes with What-If

```bash
az deployment group what-if \
  --resource-group my-rg \
  --template-file dist/template.json
```

Shows a color-coded diff of what Azure will create, modify, or delete. Always run this before deploying to production.

### What each step catches

| Step | Rule IDs | Catches | When to run |
|------|----------|---------|-------------|
| `chant lint` | AZR001 | Hardcoded location strings (use `Azure.ResourceGroupLocation`) | Every edit |
| `chant lint` | AZR002 | Storage account missing HTTPS-only | Every edit |
| `chant lint` | AZR003 | NSG rule with wildcard source (`*`) | Every edit |
| `chant build` (post-synth) | AZR010 | Redundant dependsOn (already implied by reference) | Before deploy |
| `chant build` (post-synth) | AZR011 | Missing or invalid apiVersion on resource | Before deploy |
| `chant build` (post-synth) | AZR012 | Deprecated API version | Before deploy |
| `chant build` (post-synth) | AZR013 | Resource missing location field | Before deploy |
| `chant build` (post-synth) | AZR014 | Public blob access enabled on storage | Before deploy |
| `chant build` (post-synth) | AZR015 | Missing encryption (storage, disk, database) | Before deploy |
| `chant build` (post-synth) | AZR016 | Key Vault missing soft delete | Before deploy |
| `chant build` (post-synth) | AZR017 | Key Vault missing purge protection | Before deploy |
| `chant build` (post-synth) | AZR018 | SQL Server missing auditing | Before deploy |
| `chant build` (post-synth) | AZR019 | SQL Server missing TDE (transparent data encryption) | Before deploy |
| `chant build` (post-synth) | AZR020 | App Service missing managed identity | Before deploy |
| `chant build` (post-synth) | AZR021 | App Service missing HTTPS-only | Before deploy |
| `chant build` (post-synth) | AZR022 | App Service missing minimum TLS 1.2 | Before deploy |
| `chant build` (post-synth) | AZR023 | VM missing managed disk | Before deploy |
| `chant build` (post-synth) | AZR024 | VM missing boot diagnostics | Before deploy |
| `chant build` (post-synth) | AZR025 | AKS missing RBAC | Before deploy |
| `chant build` (post-synth) | AZR026 | AKS missing network policy | Before deploy |
| `chant build` (post-synth) | AZR027 | Container registry admin account enabled | Before deploy |
| `chant build` (post-synth) | AZR028 | Network interface missing NSG association | Before deploy |
| `chant build` (post-synth) | AZR029 | Disk missing encryption | Before deploy |
| `az deployment group validate` | — | Quota limits, naming conflicts, API version issues, invalid field values | Before deploy |
| `az deployment group what-if` | — | Create/modify/delete preview of all resource changes | Before deploy |

## Basic resource declaration

```typescript
import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";

export const storage = new StorageAccount({
  name: "mystorageaccount",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  supportsHttpsTrafficOnly: true,
  minimumTlsVersion: "TLS1_2",
});
```

## ARM template functions (intrinsics)

ARM template functions are available as typed functions:

```typescript
import { ResourceId, Reference, Concat, UniqueString, Format, If } from "@intentius/chant-lexicon-azure";

// Generate a resource ID
const id = ResourceId("Microsoft.Storage/storageAccounts", "myStorage");

// Reference a deployed resource's runtime state
const ref = Reference("myStorage", "2023-01-01");

// Concatenate strings
const name = Concat("prefix-", "suffix");

// Generate a deterministic hash
const unique = UniqueString("seed-value");

// Conditional value
const sku = If("isProd", "Standard_GRS", "Standard_LRS");
```

## Azure pseudo-parameters

```typescript
import { Azure } from "@intentius/chant-lexicon-azure";

// Available pseudo-parameters:
Azure.ResourceGroupName      // [resourceGroup().name]
Azure.ResourceGroupLocation  // [resourceGroup().location]
Azure.ResourceGroupId        // [resourceGroup().id]
Azure.SubscriptionId         // [subscription().subscriptionId]
Azure.TenantId              // [subscription().tenantId]
Azure.DeploymentName        // [deployment().name]
```

## Composites reference

Composites group related Azure resources with secure defaults. Each returns an object containing the individual resources.

| Composite | Creates | Secure defaults |
|-----------|---------|-----------------|
| `StorageAccountSecure` | StorageAccount + encryption config | HTTPS-only, TLS 1.2, blob public access disabled, encryption at rest |
| `VnetDefault` | VirtualNetwork + Subnet(s) + NSG + RouteTable | Two subnets, NSG with deny-all inbound, UDR for forced tunneling |
| `AppService` | AppServicePlan + WebApp | Managed identity, HTTPS-only, TLS 1.2, always-on |
| `FunctionApp` | AppServicePlan (Consumption) + FunctionApp + StorageAccount | Managed identity, HTTPS-only, runtime-specific settings |
| `ServiceBusPipeline` | ServiceBusNamespace + Queue | Standard tier, message TTL, dead-letter queue |
| `CosmosDatabase` | CosmosDBAccount + Database + Container | Automatic failover, consistent prefix, partition key required |
| `ApplicationGateway` | PublicIP + ApplicationGateway | WAF v2 enabled, OWASP 3.2 ruleset, SSL policy |
| `ContainerInstance` | ContainerGroup | No public IP by default, resource limits set |
| `RedisCache` | RedisCache | TLS 1.2 required, non-SSL port disabled |
| `PrivateEndpoint` | PrivateEndpoint + PrivateDnsZone + VnetLink | DNS zone auto-registration, manual approval disabled |
| `AksCluster` | ManagedCluster + AgentPool | RBAC enabled, network policy (calico), managed identity, Azure CNI |
| `SqlDatabase` | SQLServer + Database + FirewallRule + AuditingSettings | TDE enabled, auditing enabled, TLS 1.2, no Azure-wide firewall rule |
| `KeyVaultSecure` | KeyVault + AccessPolicy | Soft delete, purge protection, RBAC authorization, network ACLs |
| `ContainerRegistrySecure` | ContainerRegistry | Admin disabled, premium SKU, content trust, geo-replication |
| `VmLinux` | VirtualMachine + NetworkInterface + OSDisk | Managed disk, boot diagnostics, SSH key auth (no password), managed identity |

### Example: Secure storage with private endpoint

```typescript
import { StorageAccountSecure, PrivateEndpoint, VnetDefault } from "@intentius/chant-lexicon-azure";

const { virtualNetwork, subnet1 } = VnetDefault({
  name: "app-vnet",
  addressPrefix: "10.0.0.0/16",
});

const { storageAccount } = StorageAccountSecure({ name: "appstorage" });

const { privateEndpoint, privateDnsZone } = PrivateEndpoint({
  name: "storage-pe",
  targetResourceId: ResourceId("Microsoft.Storage/storageAccounts", "appstorage"),
  groupId: "blob",
  subnetId: ResourceId("Microsoft.Network/virtualNetworks/subnets", "app-vnet", "subnet-1"),
  privateDnsZoneName: "privatelink.blob.core.windows.net",
  vnetId: ResourceId("Microsoft.Network/virtualNetworks", "app-vnet"),
});
```

### Example: AKS cluster

```typescript
import { AksCluster } from "@intentius/chant-lexicon-azure";

const { cluster } = AksCluster({
  name: "prod-aks",
  kubernetesVersion: "1.28",
  nodeCount: 3,
  vmSize: "Standard_D4s_v3",
});
```

## Default tags

Apply tags to all taggable resources:

```typescript
import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-app" },
  { key: "Environment", value: "production" },
  { key: "ManagedBy", value: "chant" },
]);
```

## What-If preview (critical for safety)

Always run What-If before deploying to any environment. This is Azure's equivalent of a dry-run that shows the actual effect of your template:

```bash
az deployment group what-if \
  --resource-group my-rg \
  --template-file dist/template.json \
  --parameters @params.json
```

What-If output uses color-coded change types:

| Symbol | Change type | Meaning |
|--------|------------|---------|
| `+` (green) | Create | New resource will be created |
| `~` (purple) | Modify | Existing resource will be updated |
| `-` (red) | Delete | Resource will be removed |
| `*` (yellow) | No change | Resource exists and matches template |
| `!` (orange) | Ignore | Resource exists but is not in template scope |

If What-If shows unexpected deletes, stop and investigate before deploying.

### Filtering What-If results

```bash
# Show only resources that will change
az deployment group what-if \
  --resource-group my-rg \
  --template-file dist/template.json \
  --result-format ResourceIdOnly
```

## Deploy lifecycle

### 1. Build and validate

```bash
chant build src/ --output dist/template.json
chant lint src/
az deployment group validate \
  --resource-group my-rg \
  --template-file dist/template.json
```

### 2. Preview

```bash
az deployment group what-if \
  --resource-group my-rg \
  --template-file dist/template.json
```

### 3. Deploy

```bash
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --name "deploy-$(date +%Y%m%d-%H%M%S)"
```

Always use a unique deployment name (timestamp-based) so you can track and roll back individual deployments.

### 4. Verify

```bash
# Check deployment status
az deployment group show \
  --resource-group my-rg \
  --name deploy-20260307-143000

# List all resources in the group
az resource list --resource-group my-rg --output table

# Check a specific resource
az storage account show --name mystorageaccount --resource-group my-rg
```

### 5. Capture state

```bash
chant state snapshot staging azure
```

### Deploying with parameters

```bash
# Inline parameters
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --parameters environment=staging sku=Standard_LRS

# Parameters file
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --parameters @params.staging.json
```

## Rollback patterns

### Revert to a previous deployment

ARM keeps deployment history. You can redeploy a previous successful deployment:

```bash
# List recent deployments
az deployment group list \
  --resource-group my-rg \
  --output table \
  --query "[].{name:name, timestamp:properties.timestamp, state:properties.provisioningState}"

# Redeploy a previous deployment by name
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --name rollback-$(date +%Y%m%d-%H%M%S) \
  --rollback-on-error
```

### Source-level rollback

Revert the TypeScript, rebuild, and redeploy:

```bash
git checkout HEAD~1 -- src/
chant build src/ --output dist/template.json
az deployment group what-if \
  --resource-group my-rg \
  --template-file dist/template.json
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json
```

### Automatic rollback on error

Use the `--rollback-on-error` flag to automatically revert to the last successful deployment if the current one fails:

```bash
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --rollback-on-error
```

### Delete a specific resource

```bash
az resource delete \
  --resource-group my-rg \
  --resource-type Microsoft.Storage/storageAccounts \
  --name mystorageaccount
```

## Troubleshooting decision tree

### Deployment failed

```
az deployment group show --resource-group my-rg --name <deployment-name>
  provisioningState: "Failed"
    -> Check the error:
      "InvalidTemplateDeployment"
        -> Template-level error. Run `chant lint` and `az deployment group validate`.
      "ResourceDeploymentFailure"
        -> Individual resource failed. Check inner error:
          "Conflict" / "409"
            -> Resource already exists with different config
            -> Use incremental mode (default) and ensure names are correct
          "QuotaExceeded"
            -> Request quota increase: az quota request create
          "AuthorizationFailed"
            -> Service principal lacks permissions
            -> Assign required role: az role assignment create
          "InvalidResourceReference"
            -> dependsOn or resourceId points to non-existent resource
            -> Check spelling and resource type in ResourceId() calls
          "SkuNotAvailable"
            -> Selected SKU not available in target region
            -> List available SKUs: az vm list-skus --location <region>
          "PublicIPCountLimitReached"
            -> Too many public IPs in subscription
            -> Delete unused IPs or request quota increase
```

### Common error patterns

| Error code | Cause | Fix |
|-----------|-------|-----|
| `InvalidTemplate` | Malformed ARM JSON | Run `chant lint src/` to catch issues pre-synth |
| `InvalidApiVersionForResourceType` | Wrong apiVersion for the resource type | Chant auto-injects correct versions; check for manual overrides |
| `ResourceGroupNotFound` | Target RG doesn't exist | `az group create --name my-rg --location eastus` |
| `DeploymentFailed` | One or more resources failed | `az deployment operation group list` to find which resource |
| `LinkedAuthorizationFailed` | Cross-resource-group reference lacks permissions | Ensure SP has Reader on the referenced RG |
| `MissingSubscriptionRegistration` | Resource provider not registered | `az provider register --namespace Microsoft.Xxx` |
| `RequestDisallowedByPolicy` | Azure Policy blocks the operation | Check policy assignments: `az policy assignment list` |
| `StorageAccountAlreadyTaken` | Globally unique name conflict | Use `UniqueString()` to generate unique storage names |
| `NameNotAvailable` | Resource name already taken (global namespace) | Choose a different name or use `UniqueString()` |
| `ParentResourceNotFound` | Child resource created before parent | Check dependsOn chain; chant auto-generates these from refs |

### Viewing deployment operations

When a deployment fails, drill into the individual operations to find the root cause:

```bash
# List all operations for a deployment
az deployment operation group list \
  --resource-group my-rg \
  --name <deployment-name> \
  --query "[?properties.provisioningState=='Failed']"
```

## Quick reference commands

| Command | Description |
|---------|-------------|
| `chant build src/` | Synthesize ARM template |
| `chant build src/ --output dist/template.json` | Synthesize to a specific file |
| `chant lint src/` | Check for anti-patterns (pre-synth + post-synth) |
| `chant state diff staging azure` | Compare current build against last snapshot |
| `chant state snapshot staging azure` | Capture current deployment state |
| `az deployment group validate --resource-group RG --template-file dist/template.json` | Server-side validation |
| `az deployment group what-if --resource-group RG --template-file dist/template.json` | Preview changes |
| `az deployment group create --resource-group RG --template-file dist/template.json` | Deploy template |
| `az deployment group create ... --rollback-on-error` | Deploy with auto-rollback |
| `az deployment group show --resource-group RG --name NAME` | Check deployment status |
| `az deployment group list --resource-group RG --output table` | List deployment history |
| `az deployment operation group list --resource-group RG --name NAME` | Drill into failed operations |
| `az resource list --resource-group RG --output table` | List all resources in RG |
| `az group create --name RG --location LOCATION` | Create resource group |

## Key differences from AWS/CloudFormation

- Resources are in an **array** (not keyed by logical name)
- Each resource requires an **apiVersion** (injected automatically by chant)
- Resource-level fields like `sku`, `kind`, `location`, `tags` live outside `properties`
- ARM uses **bracket expressions** (`[resourceId(...)]`) instead of JSON objects (`{ "Ref": "..." }`)
- Default location is `[resourceGroup().location]`
- Deployments are scoped to a **resource group** (not a stack)
- ARM supports **incremental** (default) and **complete** deployment modes
  - Incremental: only adds/updates resources in the template; leaves others alone
  - Complete: deletes resources not in the template — use with extreme caution

## Deployment modes

| Mode | Behavior | When to use |
|------|----------|-------------|
| Incremental (default) | Adds or updates resources in the template. Does not delete resources not in the template. | Most deployments |
| Complete | Deletes resources in the resource group that are not in the template. | Full environment teardown/rebuild only |

**Never use Complete mode in production** unless you explicitly intend to delete resources not in the template. Use incremental mode (the default) for all normal deployments.

```bash
# Explicit incremental (same as default)
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --mode Incremental

# Complete mode — DANGER: deletes resources not in template
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json \
  --mode Complete
```
