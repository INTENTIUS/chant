# Lambda SQS

A Lambda function that processes messages from an SQS queue, built using the `LambdaSqs` composite — the standard pattern for queue-driven Lambda consumers with automatic event source mapping and IAM scoping.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-sqs example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-sqs
```

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 4 CloudFormation resources:

- **SQS Queue** — standard queue for message buffering
- **IAM Role** — execution role with an inline policy scoped to `sqs:ReceiveMessage` on the queue
- **Lambda Function** — Node.js 20.x function that processes batches of messages and reports failures via `batchItemFailures`
- **Event Source Mapping** — connects the queue to the function with a batch size of 10

When messages arrive in the queue, Lambda automatically polls and invokes the function with batches of records.

## Project Structure

```
src/
└── main.ts       # LambdaSqs composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaSqs` creates the queue, role, function, and event source mapping as a single unit
2. **Event source mapping** — `EventSourceMapping` connects the SQS queue to the Lambda function automatically
3. **Batch configuration** — `batchSize` controls how many messages are delivered per invocation (default: 10); `maxBatchingWindow` adds a wait window in seconds
4. **Partial batch response** — the handler returns `batchItemFailures` for fine-grained retry control
5. **Action constants** — the composite uses `SQSActions.ReceiveMessage` internally for typed IAM action arrays

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
