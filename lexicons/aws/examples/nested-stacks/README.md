# Nested Stacks

A VPC network layer in a child stack, referenced by a Lambda function in the parent — demonstrating child projects, `stackOutput()`, and cross-stack references.

> **Note:** This example uses local workspace dependencies (`workspace:*`).

## Quick Start

```bash
bun run build
```

## Project Structure

```
src/
├── _.ts              # Parent barrel
├── app.ts            # Lambda function (references network outputs)
└── network/          # Child project (nested stack)
    ├── _.ts          # Child barrel
    ├── vpc.ts        # VPC, subnet, internet gateway, route table
    ├── security.ts   # Security group for Lambda
    └── outputs.ts    # stackOutput() declarations
```

## Patterns Demonstrated

1. **Child project** — `network/` has its own barrel and builds independently
2. **`stackOutput()`** — child declares which values the parent can reference
3. **`nestedStack()`** — parent references the child directory, gets an `outputs` proxy
4. **Cross-stack references** — `network.outputs.subnetId` serializes to `Fn::GetAtt` on `AWS::CloudFormation::Stack`
5. **Multi-file output** — build produces `template.json` (parent) and `network.template.json` (child)

## Build Output

```bash
bun run build
# Produces two templates:
#   template.json              — parent (Lambda + AWS::CloudFormation::Stack)
#   network.template.json      — child (VPC, subnet, IGW, routes, security group)
```

The child can also be built independently:

```bash
chant build src/network/ --lexicon aws
```
