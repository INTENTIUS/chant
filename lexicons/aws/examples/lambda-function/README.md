# Lambda Function

The simplest possible Chant example — a single Node.js Lambda function that returns a greeting, built using the `LambdaNode` preset composite.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the lambda-function example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast lambda-function
```

## Quick Start

```bash
npm run build
```

## What It Does

The stack creates 2 CloudFormation resources:

- **IAM Role** — execution role with `AWSLambdaBasicExecutionRole` managed policy and `lambda.amazonaws.com` trust
- **Lambda Function** — Node.js 20.x function that logs the incoming event and returns `{ message: "Hello from Lambda!" }`

`LambdaNode` is a preset of `LambdaFunction` with `Runtime: "nodejs20.x"` and `Handler: "index.handler"` baked in, so you only need to provide a name and code.

## Project Structure

```
src/
└── main.ts       # LambdaNode composite instantiation + inline handler
```

## Patterns Demonstrated

1. **Preset composites** — `LambdaNode` wraps `LambdaFunction` with `withDefaults`, eliminating boilerplate for the most common runtime
2. **Inline handler code** — `Code.ZipFile` embeds the handler source directly in the CloudFormation template (no separate artifact)
3. **Dynamic naming** — `Sub` + `AWS.StackName` generates a unique function name per stack deployment

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
