# Lambda SNS

A Lambda function triggered by SNS notifications, built using the `LambdaSns` composite — the standard pub/sub pattern for fan-out event processing.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-sns example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-sns
```

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 5 CloudFormation resources:

- **SNS Topic** — notification topic that accepts published messages
- **IAM Role** — Lambda execution role with `AWSLambdaBasicExecutionRole` managed policy
- **Lambda Function** — Node.js 20.x function that logs each notification's parsed message body
- **SNS Subscription** — subscribes the function to the topic via the `lambda` protocol
- **Lambda Permission** — grants `sns.amazonaws.com` permission to invoke the function

When a message is published to the topic, SNS delivers it to the Lambda function via the subscription.

## Project Structure

```
src/
└── main.ts       # LambdaSns composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Composites** — `LambdaSns` creates the topic, role, function, subscription, and permission as a single unit
2. **Push-based invocation** — unlike SQS (poll-based), SNS pushes notifications directly to the Lambda function
3. **Resource-based permissions** — `Permission` grants the SNS service principal the right to invoke the function, scoped to the topic's ARN
4. **SNS event structure** — the handler accesses `record.Sns.Message` to read the published payload

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
