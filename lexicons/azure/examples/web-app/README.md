# Web App

App Service with managed identity, HTTPS-only, and TLS 1.2 — built using the `AppService` composite.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon azure`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-azure` | `@intentius/chant-lexicon-azure` | Azure ARM lifecycle: build, lint, deploy, rollback, troubleshooting |
| `chant-azure-security` | `@intentius/chant-lexicon-azure` | Security best practices: managed identity, encryption, network hardening |
| `chant-azure-patterns` | `@intentius/chant-lexicon-azure` | Advanced patterns: cross-resource references, linked deployments, multi-region |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the web-app example to my Azure resource group.
> ```

## What this produces

- **Azure** (`template.json`): 2 ARM resources across 2 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/main.ts` | `AppService` | App Service Plan (`serverfarms`), Web App (`sites`) |
| `src/tags.ts` | — | Default tags |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az`)
- [ ] An Azure subscription
- [ ] A resource group (`az group create --name $RESOURCE_GROUP --location eastus`)

**Local verification** (build, lint) requires only Node.js — no Azure account needed.

## Local verification

```bash
npx chant build src --lexicon azure -o template.json
npx chant lint src
```

## Deploy

```bash
az deployment group create --resource-group "$RESOURCE_GROUP" --template-file template.json
```

## Verify

```bash
az webapp show --name chant-web-app --resource-group "$RESOURCE_GROUP"
```

## Teardown

```bash
az group delete --name "$RESOURCE_GROUP" --yes
```

Deletes the resource group and all resources within it.

## Related examples

- [basic-storage](../basic-storage/) — Minimal single-resource example
- [multi-resource](../multi-resource/) — Cross-resource references with ARM intrinsics
- [function-app](../function-app/) — Serverless Functions on Azure
