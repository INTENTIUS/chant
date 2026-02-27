---
source: chant-lexicon
name: chant-azure
description: Azure Resource Manager infrastructure generation with chant
---

# Azure ARM Template Patterns with Chant

## Overview

The `@intentius/chant-lexicon-azure` package provides type-safe Azure Resource Manager (ARM) infrastructure declarations that serialize to ARM template JSON.

## Installation

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-azure
```

## Basic Resource Declaration

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

## ARM Template Functions (Intrinsics)

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
```

## Azure Pseudo-Parameters

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

## Composites

Composites group related Azure resources with secure defaults:

```typescript
import { StorageAccountSecure, VnetDefault, AppService } from "@intentius/chant-lexicon-azure";

// Secure storage with encryption, HTTPS, and TLS 1.2
const { storageAccount } = StorageAccountSecure({ name: "mystorage" });

// VNet with two subnets, NSG, and route table
const { virtualNetwork, subnet1, subnet2, nsg } = VnetDefault({
  name: "myvnet",
  addressPrefix: "10.0.0.0/16",
});

// App Service Plan + Web App with managed identity
const { plan, webApp } = AppService({
  name: "myapp",
  runtime: "NODE|18-lts",
});
```

## Default Tags

Apply tags to all taggable resources:

```typescript
import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-app" },
  { key: "Environment", value: "production" },
  { key: "ManagedBy", value: "chant" },
]);
```

## Building

```bash
chant build src --lexicon azure
# Writes dist/template.json
```

## Deploying

```bash
az deployment group create \
  --resource-group my-rg \
  --template-file dist/template.json
```

## Key Differences from AWS/CloudFormation

- Resources are in an **array** (not keyed by logical name)
- Each resource requires an **apiVersion** (injected automatically)
- Resource-level fields like `sku`, `kind`, `location`, `tags` live outside `properties`
- ARM uses **bracket expressions** (`[resourceId(...)]`) instead of JSON objects (`{ "Ref": "..." }`)
- Default location is `[resourceGroup().location]`
