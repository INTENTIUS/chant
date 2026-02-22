# Lambda Patterns

Built-in composites, action constants, and multiple Lambda patterns —
API endpoints, background workers, scheduled tasks, and event publishers.

> **Note:** This example uses local workspace dependencies (`workspace:*`).
> Once `@intentius/chant-lexicon-aws` is published to npm, update `package.json` to use versioned dependencies.

## Quick Start

```bash
bun run build
```

## Project Structure

```
src/
├── data-table.ts          # DynamoDB table
├── api.ts                 # LambdaApi — API endpoint with DynamoDB access
├── worker.ts              # NodeLambda — background worker with S3 write access
├── scheduled-cleanup.ts   # ScheduledLambda — daily cleanup with EventBridge
└── notifier.ts            # NodeLambda — SNS publisher
```

## Patterns Demonstrated

1. **Built-in composites** — `LambdaApi`, `NodeLambda`, `ScheduledLambda` instead of hand-built Role + Function + Permission
2. **Action constants** — `DynamoDBActions.ReadWrite`, `S3Actions.PutObject`, `SNSActions.Publish` for typed IAM policies
3. **Runtime presets** — `NodeLambda` defaults to `nodejs20.x` + `index.handler`
4. **Scheduled execution** — `ScheduledLambda` auto-creates EventBridge Rule + Permission
5. **Cross-resource references** — Lambda environment variables reference DynamoDB/S3/SNS ARNs
