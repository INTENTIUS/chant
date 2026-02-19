# chant

A type system for operations.

**[Read the docs →](https://intentius.io/chant/getting-started/introduction/)**

> chant is in active development. Packages are published under the [`@intentius`](https://www.npmjs.com/org/intentius) org on npm.

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