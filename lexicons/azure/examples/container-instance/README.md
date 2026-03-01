# Container Instance

A single Azure Container Instance running a hello-world image — built using the `ContainerInstance` composite.

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
> Deploy the container-instance example to my Azure resource group.
> ```

## What this produces

- **Azure** (`template.json`): 1 ARM resource across 2 source files

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/main.ts` | `ContainerInstance` | ContainerInstance/containerGroups |
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
az container show --name chant-ci --resource-group "$RESOURCE_GROUP" --query provisioningState
az container logs --name chant-ci --resource-group "$RESOURCE_GROUP"
```

## Teardown

```bash
az group delete --name "$RESOURCE_GROUP" --yes
```

Deletes the resource group and all resources within it.

## Related examples

- [function-app](../function-app/) — Serverless Function App with storage backend
- [web-app](../web-app/) — App Service with managed identity
- [aks-cluster](../aks-cluster/) — Full Kubernetes cluster with ACR and VNet
