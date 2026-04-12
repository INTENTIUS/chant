# Lambda DynamoDB

A Lambda function that reads and writes items to a DynamoDB table, built using the `LambdaDynamoDB` composite — the standard pattern for Lambda-to-DynamoDB access with automatic IAM scoping, table creation, and environment wiring.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-dynamodb example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-dynamodb
```

## Quick Start

```bash
npm run build
```

## What It Does

The stack creates 3 CloudFormation resources:

- **DynamoDB Table** — on-demand billing (`PAY_PER_REQUEST`), partition key `pk` of type String
- **IAM Role** — execution role with an inline policy scoped to DynamoDB read/write actions on the table
- **Lambda Function** — Node.js 20.x function that handles `POST` (put item) and `GET` (get item by id)

The composite automatically injects `TABLE_NAME` into the function's environment variables, so the handler can reference `process.env.TABLE_NAME` without manual wiring.

## Project Structure

```
src/
└── main.ts       # LambdaDynamoDB composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaDynamoDB` creates the table, role, and function as a single unit with correct wiring
2. **Key schema** — `partitionKey` (required) and `sortKey` (optional) configure the table's key schema and attribute definitions
3. **Access levels** — `access: "ReadWrite"` scopes the IAM policy to read/write DynamoDB actions; other options are `"ReadOnly"` and `"Full"`
4. **Action constants** — the composite uses `DynamoDBActions.ReadWrite` internally for typed IAM action arrays
5. **Automatic environment injection** — `TABLE_NAME` is added to the function environment without explicit configuration

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
