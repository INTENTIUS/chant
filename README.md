# chant

A type system for operations.

Declare your infrastructure and configuration as typed TypeScript objects. chant discovers your declarations, validates them with semantic lint rules, resolves dependencies, and builds artifacts for your target platform.

> chant is in active development. Packages are not yet published to npm.

## What It Looks Like

```typescript
import * as aws from "@intentius/chant-lexicon-aws";

export const versioningEnabled = new aws.VersioningConfiguration({
  status: "Enabled",
});

export const dataBucket = new aws.Bucket({
  bucketName: "my-app-data",
  versioningConfiguration: versioningEnabled,
});
```

## Packages

| Package | Description |
|---------|-------------|
| [@intentius/chant](packages/core) | Type system, discovery, build pipeline, semantic lint engine, CLI |
| [@intentius/chant-lexicon-chant](lexicons/chant) | Core lint rules (COR, EVL) |
| [@intentius/chant-lexicon-aws](lexicons/aws) | AWS lexicon — S3, Lambda, IAM types + semantic lint rules |
| [@intentius/chant-test-utils](packages/test-utils) | Shared testing utilities |

## Development

### Prerequisites

- [Bun](https://bun.sh) — package manager, runtime, and test runner
- [just](https://just.systems) — task runner (optional)

### Setup

```bash
git clone <repo-url>
cd chant
bun install
just check    # type-check + lint + test
```

### Commands

```bash
just build    # Type check
just test     # Run tests
just lint     # Run linter
just check    # All of the above
just docs     # Start docs dev server
```
