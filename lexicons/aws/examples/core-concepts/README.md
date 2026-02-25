# Core Concepts

Twelve standalone snippets that each demonstrate a single chant concept — from declaring a basic S3 bucket to building a multi-resource composite. Designed for copy-paste reference, not as a connected project.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Project Structure

```
src/
├── resource-basic.ts         # Simple S3 bucket with versioning
├── resource-tags.ts          # Bucket with tags
├── resource-attributes.ts    # Using resource attributes (Arn, etc.)
├── cross-ref-storage.ts      # Data bucket (exported for cross-file use)
├── cross-ref-policy.ts       # IAM role + policy referencing the data bucket
├── cross-ref-combined.ts     # Policy combining imports from multiple files
├── preset-defaults.ts        # Reusable encryption and public access config
├── preset-usage.ts           # Bucket using preset defaults
├── composite-definition.ts   # LambdaService composite (Role + Function)
├── composite-usage.ts        # Using the LambdaService composite
├── parameters.ts             # CloudFormation Parameters
└── outputs.ts                # Stack Outputs
```

## Patterns Demonstrated

1. **Basic resources** — simple typed declarations with properties
2. **Tags** — array of key/value tag objects
3. **Cross-file references** — `resource.Arn` serializes to `Fn::GetAtt`
4. **Shared config** — extract reusable property objects into a defaults file
5. **Composites** — multi-resource abstractions returning structured objects
