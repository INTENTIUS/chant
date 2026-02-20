# @intentius/chant-lexicon-aws

> Part of the [chant](../../README.md) monorepo. Published as [`@intentius/chant-lexicon-aws`](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) on npm.

AWS CloudFormation lexicon for chant — declare infrastructure as flat, typed TypeScript that serializes to CloudFormation JSON templates.

## Overview

This package provides:

- **CloudFormation serializer** — converts chant declarables to CloudFormation JSON templates
- **Intrinsic functions** — type-safe `Fn::Sub`, `Fn::GetAtt`, `Fn::Join`, etc.
- **Pseudo-parameters** — `AWS::Region`, `AWS::AccountId`, `AWS::StackName`, etc.
- **Resource types** — generated constructors for S3, Lambda, IAM, and all CloudFormation resource types
- **Lint rules** — AWS-specific validation (e.g. hardcoded region detection)
- **Code generation** — generates TypeScript types from CloudFormation resource specs
- **LSP/MCP support** — completions and hover for AWS resource types

**[Full documentation →](https://intentius.io/chant/lexicons/aws/)**

## CloudFormation Concepts

Every exported resource becomes a logical resource in the CloudFormation template. The serializer handles naming conventions, `AttrRef` resolution, parameters, outputs, and tagging automatically. See [CloudFormation concepts](https://intentius.io/chant/lexicons/aws/cloudformation/) for details.

## Intrinsic Functions

Type-safe wrappers for all CloudFormation intrinsic functions: `Sub`, `Ref`, `GetAtt`, `Join`, `If`, `Select`, `Split`, `Base64`, and `GetAZs`. See [Intrinsics](https://intentius.io/chant/lexicons/aws/intrinsics/) for usage.

## Pseudo-Parameters

All CloudFormation pseudo-parameters are available via the `AWS` namespace: `AWS.Region`, `AWS.AccountId`, `AWS.StackName`, etc.

## Examples

Three runnable examples live in `examples/`. All have tests you can run with `bun test`.

### Getting Started (`examples/getting-started/`)

Declares 4 resources across separate files: two S3 buckets, an IAM role, and a Lambda function. Demonstrates flat declarations, barrel sharing, cross-resource references, and intrinsics.

### Advanced (`examples/advanced/`)

Builds on getting-started with composites, composite presets (`withDefaults`), inline IAM policies, and custom lint rules.

### Nested Stacks (`examples/nested-stacks/`)

Demonstrates child projects for CloudFormation nested stacks with cross-stack outputs.

## Composites

Composites group related resources into reusable factories. Use `withDefaults` for presets and `propagate` for shared properties like tags. See [Composites](https://intentius.io/chant/lexicons/aws/composites/) for details.

## Custom Lint Rules

Write project-specific lint rules that enforce domain conventions via TypeScript AST visitors. See [Custom Rules](https://intentius.io/chant/lexicons/aws/custom-rules/) for details.

## Built-in Lint Rules

AWS-specific lint rules for hardcoded regions, missing encryption, IAM wildcards, and more. See [Lint Rules](https://intentius.io/chant/lexicons/aws/lint-rules/) for the full list.

## Code Generation

The AWS lexicon uses core's `generatePipeline` with AWS-specific callbacks:

- `codegen/generate.ts` — calls core `generatePipeline<SchemaParseResult>` with AWS callbacks
- `codegen/naming.ts` — extends core `NamingStrategy` with AWS data tables
- `codegen/package.ts` — calls core `packagePipeline` with AWS manifest and skill collector
- `spec/fetch.ts` — uses core `fetchWithCache` + `extractFromZip` for CloudFormation schema

## Related Packages

- `@intentius/chant` — core functionality, type system, and CLI

## License

See the main project LICENSE file.
