# Cosmos DB

A Cosmos DB account with a SQL database and container — built using the `CosmosDatabase` composite.

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
> Deploy the cosmos-db example to my Azure resource group.
> ```

## What this produces

- **Azure** (`template.json`): 3 ARM resources across 2 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/main.ts` | `CosmosDatabase` | DocumentDB/databaseAccounts + sqlDatabases + containers |
| `src/tags.ts` | *(default tags)* | — |

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
az cosmosdb show --name chant-cosmos --resource-group "$RESOURCE_GROUP" --query provisioningState
az cosmosdb sql database list --account-name chant-cosmos --resource-group "$RESOURCE_GROUP" -o table
```

## Teardown

```bash
az group delete --name "$RESOURCE_GROUP" --yes
```

Deletes the resource group and all resources within it.

## Related examples

- [sql-database](../sql-database/) — Azure SQL Server with database and firewall rules
- [redis-cache](../redis-cache/) — Azure Cache for Redis
- [multi-resource](../multi-resource/) — Cross-resource references with ARM intrinsics

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
