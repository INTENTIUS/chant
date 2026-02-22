# Getting Started with chant AWS

A Lambda that lists objects in an S3 bucket — the simplest real-world pattern: one bucket, one role with scoped read permissions, and one function wired together with typed cross-resource references.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Quick Start

```bash
# Build CloudFormation from src/
bun run build
```

Deploy with a `name` parameter (required — used in all resource names):

```bash
aws cloudformation deploy \
  --template-file dist/template.json \
  --stack-name my-stack \
  --parameter-overrides name=myproject \
  --capabilities CAPABILITY_NAMED_IAM
```

## Project Structure

```
src/
├── defaults.ts       # Shared config: S3 encryption, public access block, Lambda trust policy, name parameter
├── config.ts         # Stack outputs (data bucket ARN)
├── data-bucket.ts    # Encrypted S3 bucket for application data
├── role.ts           # IAM role with S3 read-only inline policy (ListBucket + GetObject)
└── handler.ts        # Lambda that lists objects in the data bucket using AWS SDK v3
```

## What It Does

The stack creates three resources following the naming pattern `{AccountId}-{name}-chant-<suffix>`:

1. **Data bucket** — AES-256 encrypted S3 bucket with all public access blocked
2. **Execution role** — IAM role that Lambda can assume, with CloudWatch Logs access and a scoped inline policy granting `s3:ListBucket` + `s3:GetObject` on the data bucket
3. **Handler** — Node.js 20 Lambda that reads `BUCKET_NAME` from its environment and returns the bucket's object listing as JSON

## Patterns Demonstrated

1. **Shared defaults** — `defaults.ts` exports reusable property objects (`BucketEncryption`, `PublicAccessBlockConfiguration`, trust policy) that resource files import directly
2. **Cross-resource references** — `dataBucket.Arn` in `role.ts` and `functionRole.Arn` in `handler.ts` serialize to `Fn::GetAtt`
3. **Action constants** — `S3Actions.ReadOnly` for typed IAM actions instead of hand-typed strings
4. **Inline policies** — `Role_Policy` scopes S3 access to the specific data bucket
5. **Intrinsics** — `Sub` tagged templates with `AWS.AccountId` and `Ref("name")` for dynamic naming
6. **Parameters & outputs** — `name` parameter for deploy-time customization, `dataBucketArn` output for cross-stack use
