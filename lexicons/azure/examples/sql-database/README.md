# SQL Database

An Azure SQL Server with a database and firewall rule — built using the `SqlDatabase` composite with ARM parameters for admin credentials.

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
> Deploy the sql-database example to my Azure resource group.
> ```

## What this produces

- **Azure** (`template.json`): 3 ARM resources across 2 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/main.ts` | `SqlDatabase` | Sql/servers + servers/databases + servers/firewallRules |
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
az sql server show --name chant-sql --resource-group "$RESOURCE_GROUP" --query state
az sql db list --server chant-sql --resource-group "$RESOURCE_GROUP" -o table
```

## Teardown

```bash
az group delete --name "$RESOURCE_GROUP" --yes
```

Deletes the resource group and all resources within it.

## Related examples

- [cosmos-db](../cosmos-db/) — Cosmos DB with SQL database and container
- [key-vault](../key-vault/) — Secure Key Vault
- [private-endpoint](../private-endpoint/) — Private connectivity with DNS integration
