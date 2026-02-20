# @intentius/chant-lexicon-aws

AWS CloudFormation lexicon for [chant](https://intentius.io/chant/) — declare infrastructure as typed TypeScript that serializes to CloudFormation JSON templates.

This package provides generated constructors for all CloudFormation resource and property types, type-safe intrinsic functions (`Sub`, `Ref`, `Join`, etc.), pseudo-parameters (`AWS.Region`, `AWS.AccountId`, etc.), composites for grouping related resources, and AWS-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-aws
```

**[Documentation →](https://intentius.io/chant/lexicons/aws/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-gitlab](https://www.npmjs.com/package/@intentius/chant-lexicon-gitlab) | GitLab CI lexicon |

## License

See the main project LICENSE file.
