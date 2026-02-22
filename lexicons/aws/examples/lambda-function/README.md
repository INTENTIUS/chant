# Lambda Function

The simplest possible Chant example — a single Node.js Lambda function that returns a greeting, built using the `LambdaNode` preset composite.

## Quick Start

```bash
bun run build
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
