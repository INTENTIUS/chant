# Lambda Scheduled

A Lambda function that runs on a recurring schedule, built using the `LambdaScheduled` composite — the standard pattern for cron jobs and periodic tasks.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 4 CloudFormation resources:

- **IAM Role** — Lambda execution role with `AWSLambdaBasicExecutionRole` managed policy
- **Lambda Function** — Node.js 20.x function that logs the current timestamp (placeholder for cleanup logic)
- **EventBridge Rule** — schedule rule set to `rate(1 hour)` that triggers the function
- **Lambda Permission** — grants `events.amazonaws.com` permission to invoke the function

EventBridge invokes the function on the configured schedule. The rule starts in the `ENABLED` state by default.

## Project Structure

```
src/
└── main.ts       # LambdaScheduled composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaScheduled` creates the role, function, EventBridge rule, and permission as a single unit
2. **Schedule expressions** — supports both `rate(...)` expressions (e.g., `rate(1 hour)`) and `cron(...)` expressions (e.g., `cron(0 12 * * ? *)`)
3. **Shared building blocks** — `LambdaScheduled` and `LambdaEventBridge` are peer composites that both build on the shared `LambdaFunction` base; `LambdaEventBridge` also supports event pattern matching
4. **Resource-based permissions** — `Permission` grants the EventBridge service principal the right to invoke the function, scoped to the rule's ARN

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
