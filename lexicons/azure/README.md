# @intentius/chant-lexicon-azure

Azure Resource Manager (ARM) lexicon for [chant](https://intentius.io/chant/) — declare infrastructure as TypeScript that serializes to ARM template JSON.

This package provides generated constructors for Azure resource types, type-safe ARM template functions (`ResourceId`, `Reference`, `Concat`, etc.), pseudo-parameters (`Azure.ResourceGroupName`, `Azure.SubscriptionId`, etc.), composites for grouping related resources, and Azure-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-azure
```

**[Documentation →](https://intentius.io/chant/lexicons/azure/)**

## Lifecycle

chant marks what it owns with ARM tags (`src/ownership.ts`): `chant-managed-by`, `chant-stack` and `chant-env`. Azure tag keys can't hold `/`, so these differ from the label keys k8s and gcp use.

- `chant lifecycle diff <env> --live` and `chant lifecycle plan <env>` read the resource group live and compare it with the built template, keyed by those tags.
- `azApply`, the Op activity, and `arm-deploy`, the component step, apply the template resource by resource with ARM PUTs into one resource group, rather than through `az deployment`. `AZURE_ENDPOINT_URL` points them at an emulator such as floci-az.
- With `prune`, the applier deletes chant-owned resources in the group that the template no longer declares, and nothing it doesn't own.

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-k8s](https://www.npmjs.com/package/@intentius/chant-lexicon-k8s) | Kubernetes lexicon |

## License

See the main project LICENSE file.
