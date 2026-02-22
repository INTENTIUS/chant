# Lambda API

Three API endpoints backed by Lambda functions, each with different memory/timeout profiles and scoped IAM policies — built using composite factories, preset defaults, and a custom lint rule that enforces API Gateway's 29-second timeout limit.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 10 CloudFormation resources (1 S3 bucket + 3 composites × 3 members each):

- **Data bucket** — encrypted S3 storage
- **Health API** — minimal health-check endpoint (128 MB, 10s timeout)
- **Upload API** — file upload endpoint with `s3:PutObject` on the data bucket (128 MB, 10s timeout)
- **Process API** — data processing endpoint with `s3:GetObject` + `s3:PutObject` (1024 MB, 30s timeout)

Each API composite expands to an IAM Role + Lambda Function + API Gateway Lambda Permission.

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
2. **Preset factories** — SecureApi and HighMemoryApi with sensible defaults via `withDefaults`
3. **Action constants** — `S3Actions.PutObject`, `S3Actions.ReadWrite` for typed IAM policies
4. **Inline IAM policies** — `Role_Policy` scopes S3 access per endpoint
5. **Custom lint rules** — domain-specific validation (API Gateway timeout limit)
6. **Lint configuration** — `chant.config.ts` with strict preset and plugins
