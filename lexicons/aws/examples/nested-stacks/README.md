# Nested Stacks

A Lambda function in the parent stack that runs inside a VPC defined in a child stack — demonstrating how `nestedStack()` and `stackOutput()` wire cross-stack references automatically, producing two separate CloudFormation templates from a single build.

> **Note:** This example uses local workspace dependencies (`workspace:*`).

## Quick Start

```bash
bun run build
```

## What It Does

The build produces two CloudFormation templates:

- **Parent** (`template.json`) — Lambda function + `AWS::CloudFormation::Stack` resource pointing to the child
- **Child** (`network.template.json`) — VPC, subnet, internet gateway, route table, and security group

The parent references `network.outputs.subnetId` and `network.outputs.lambdaSgId`, which serialize to `Fn::GetAtt` on the nested stack resource. A `TemplateBasePath` parameter controls where CloudFormation finds child templates at deploy time.

## Project Structure

```
src/
├── app.ts            # Lambda function (references network outputs)
└── network/          # Child project (nested stack)
    ├── vpc.ts        # VPC, subnet, internet gateway, route table
    ├── security.ts   # Security group for Lambda
    └── outputs.ts    # stackOutput() declarations
```

## Patterns Demonstrated

1. **Child project** — `network/` has its own config and builds independently
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
