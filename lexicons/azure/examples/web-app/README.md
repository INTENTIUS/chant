# Web App

A Chant Azure example that deploys an App Service with a managed identity, built using the `AppService` composite.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 2 ARM resources:

- **App Service Plan** — Linux plan with B1 SKU (reserved for Linux workloads)
- **Web App** — Node.js 18 LTS site with SystemAssigned managed identity, HTTPS-only, TLS 1.2, FTPS disabled, Always On, and HTTP/2 enabled

`AppService` combines the plan and web app into a single composite with production-ready defaults including managed identity for secure access to other Azure services.

## Project Structure

```
src/
├── main.ts       # AppService composite instantiation
└── tags.ts       # Project-wide default tags
```

## Patterns Demonstrated

1. **Managed identity** — `SystemAssigned` identity is enabled by default, allowing the app to authenticate to Azure services without credentials
2. **Secure defaults** — HTTPS-only, TLS 1.2 minimum, FTPS disabled out of the box
3. **Pseudo-parameters** — `Azure.ResourceGroupLocation` deploys the app to the resource group's region
