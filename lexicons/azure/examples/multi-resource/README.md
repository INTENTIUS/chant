# Multi-Resource

A Chant Azure example demonstrating cross-resource references using ARM intrinsic functions — `ResourceId`, `Reference`, `ListKeys`, `Concat`, and `UniqueString`.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 3 ARM resources:

- **Storage Account** — Secure storage with a dynamically generated unique name
- **App Service Plan** — Linux plan with B1 SKU
- **Web App** — Node.js 18 LTS site with managed identity

It also demonstrates how to wire resources together using ARM intrinsic functions:

- `ResourceId` generates the full resource ID for the storage account
- `Reference` retrieves the runtime state of the storage account
- `ListKeys` fetches the storage account's access keys
- `Concat` + `UniqueString` creates a globally unique storage name

## Project Structure

```
src/
├── main.ts       # Multiple composites with cross-resource intrinsic references
└── tags.ts       # Project-wide default tags
```

## Patterns Demonstrated

1. **Cross-resource references** — `ResourceId` and `Reference` link the web app to the storage account at deployment time
2. **Access key retrieval** — `ListKeys` fetches storage keys for connection string construction
3. **Unique naming** — `Concat` + `UniqueString` ensures globally unique resource names derived from the resource group ID
4. **Multi-composite stacks** — Combining `StorageAccountSecure` and `AppService` in a single deployment
