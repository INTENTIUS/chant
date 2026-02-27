# Basic Storage

A minimal Chant Azure example — a single Storage Account with security hardening, built using the `StorageAccountSecure` composite.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 1 ARM resource:

- **Storage Account** — StorageV2 account with Standard_LRS replication, HTTPS-only traffic, TLS 1.2 minimum, blob/file/table/queue encryption, and default-deny network ACLs

`StorageAccountSecure` bakes in security best practices (encryption at rest, HTTPS enforcement, public blob access disabled), so you only need to provide a name and SKU.

## Project Structure

```
src/
├── main.ts       # StorageAccountSecure composite instantiation
└── tags.ts       # Project-wide default tags
```

## Patterns Demonstrated

1. **Secure-by-default composites** — `StorageAccountSecure` enforces TLS 1.2, HTTPS-only, and encryption without manual configuration
2. **Intrinsics** — `Concat` + `UniqueString` generates a globally unique storage account name
3. **Pseudo-parameters** — `Azure.ResourceGroupLocation` places the resource in the deployment's resource group region
