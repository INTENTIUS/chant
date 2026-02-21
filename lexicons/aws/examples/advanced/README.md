# Advanced Patterns

Composites, preset factories, custom lint rules, and IAM policies —
building reusable infrastructure abstractions.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Quick Start

```bash
bun run build
```

## Project Structure

```
src/
├── defaults.ts         # Shared config: encryption, versioning, trust policy
├── data-bucket.ts      # Encrypted data bucket
├── lambda-api.ts       # Composite: LambdaApi, SecureApi, HighMemoryApi factories
├── health-api.ts       # Health endpoint (SecureApi preset)
├── upload-api.ts       # Upload endpoint with S3 write policy
├── process-api.ts      # Processing endpoint with S3 read/write policy
├── chant.config.ts     # Lint config: strict preset + custom rule
└── lint/
    └── api-timeout.ts  # Custom lint rule WAW012: Lambda timeout > 29s
```

## Patterns Demonstrated

1. **Composites** — multi-resource factories (Role + Function + Permission)
2. **Preset factories** — SecureApi and HighMemoryApi with sensible defaults
3. **IAM policies** — S3 read/write permissions attached to roles
4. **Custom lint rules** — domain-specific validation (API Gateway timeout limit)
5. **Lint configuration** — chant.config.ts with strict preset and plugins
