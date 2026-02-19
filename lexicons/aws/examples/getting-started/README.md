# Getting Started with chant AWS

A quickstart example: two S3 buckets, an IAM role, and a Lambda function — all declared as flat, typed TypeScript.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Quick Start

```bash
# Build CloudFormation from src/
bun run build
```

## Project Structure

```
src/
├── _.ts              # Shared config: encryption, versioning, public access
├── data-bucket.ts    # Data bucket (uses barrel)
├── logs-bucket.ts    # Logs bucket (uses barrel)
├── role.ts           # IAM role + assume policy
└── handler.ts        # Lambda function (references bucket + role)
```

## Patterns Demonstrated

1. **Flat declarations** — every sub-resource is its own named export (`_.ts`)
2. **Barrel sharing** — `import * as _ from "./_"` shares config across files
3. **Cross-resource references** — `dataBucket.arn` and `functionRole.arn` serialize to `Fn::GetAtt`
4. **Intrinsics** — `aws.Sub` for dynamic naming with pseudo-parameters
