# Lambda S3

A Lambda function that lists objects in an S3 bucket, built using the `LambdaS3` composite — the standard pattern for Lambda-to-S3 access with automatic IAM scoping, encryption, and environment wiring.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-s3 example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-s3
```

## Quick Start

```bash
npm run build
```

## What It Does

The stack creates 3 CloudFormation resources:

- **S3 Bucket** — AES-256 server-side encryption, all public access blocked
- **IAM Role** — execution role with an inline policy scoped to `s3:GetObject`, `s3:ListBucket` on the bucket
- **Lambda Function** — Node.js 20.x function that calls `ListObjectsV2` and returns the bucket contents

The composite automatically injects `BUCKET_NAME` into the function's environment variables, so the handler can reference `process.env.BUCKET_NAME` without manual wiring.

## Project Structure

```
src/
└── main.ts       # LambdaS3 composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaS3` creates the bucket, role, and function as a single unit with correct wiring
2. **Access levels** — `access: "ReadOnly"` scopes the IAM policy to read-only S3 actions; other options are `"ReadWrite"` and `"Full"`
3. **Action constants** — the composite uses `S3Actions.ReadOnly` internally for typed IAM action arrays
4. **Automatic environment injection** — `BUCKET_NAME` is added to the function environment without explicit configuration
5. **Secure defaults** — encryption and public access blocking are applied automatically by the composite

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
