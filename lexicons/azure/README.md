# @intentius/chant-lexicon-azure

Azure Resource Manager (ARM) lexicon for [chant](https://intentius.io/chant/) — declare infrastructure as typed TypeScript that serializes to ARM template JSON.

This package provides generated constructors for Azure resource types, type-safe ARM template functions (`ResourceId`, `Reference`, `Concat`, etc.), pseudo-parameters (`Azure.ResourceGroupName`, `Azure.SubscriptionId`, etc.), composites for grouping related resources, and Azure-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-azure
```

**[Documentation →](https://intentius.io/chant/lexicons/azure/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-k8s](https://www.npmjs.com/package/@intentius/chant-lexicon-k8s) | Kubernetes lexicon |

## License

See the main project LICENSE file.
