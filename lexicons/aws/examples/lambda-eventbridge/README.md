# Lambda EventBridge

A Lambda function triggered by EventBridge events, built using the `LambdaEventBridge` composite — the standard pattern for event-driven architectures that react to AWS service events or custom application events.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-eventbridge example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-eventbridge
```

## Quick Start

```bash
npm run build
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

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
