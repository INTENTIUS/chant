# Lambda EventBridge

A Lambda function triggered by EventBridge events, built using the `LambdaEventBridge` composite — the standard pattern for event-driven architectures that react to AWS service events or custom application events.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 4 CloudFormation resources:

- **IAM Role** — Lambda execution role with `AWSLambdaBasicExecutionRole` managed policy
- **Lambda Function** — Node.js 20.x function that logs the event source, detail type, and detail payload
- **EventBridge Rule** — pattern-matching rule that fires on S3 `Object Created` events
- **Lambda Permission** — grants `events.amazonaws.com` permission to invoke the function

When an event matching the pattern arrives on the default event bus, EventBridge routes it to the Lambda function.

## Project Structure

```
src/
└── main.ts       # LambdaEventBridge composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaEventBridge` creates the role, function, EventBridge rule, and permission as a single unit
2. **Event patterns** — `eventPattern` filters events by `source` and `detail-type`; only matching events trigger the function
3. **Schedule vs. pattern** — this composite supports both `schedule` (time-based) and `eventPattern` (content-based) triggers; for schedule-only use cases, prefer the `LambdaScheduled` preset
4. **EventBridge event structure** — the handler accesses `event.source`, `event["detail-type"]`, and `event.detail` from the standard EventBridge envelope
5. **Resource-based permissions** — `Permission` grants the EventBridge service principal the right to invoke the function, scoped to the rule's ARN
