# Shared ALB

Shared VPC + ALB infrastructure for multiple independently-deployed Fargate services.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the shared-alb example to my AWS account.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast alb-infra
```

## Quick Start

```bash
# 1. Build and deploy the shared infrastructure
npm run build
aws cloudformation deploy \
  --template-file template.json \
  --stack-name shared-alb \
  --capabilities CAPABILITY_IAM

# 2. Grab the outputs for service stacks
aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].Outputs'
```

## What It Does

Deploys 24 CloudFormation resources:

- **17 VPC resources** via `VpcDefault` — VPC, subnets, NAT, routing
- **5 ALB resources** via `AlbShared` — ECS Cluster, Execution Role, ALB Security Group, ALB, Listener (404 default)
- **2 ECR repositories** — `alb-api` and `alb-ui` container registries with scan-on-push

## Stack Outputs

The stack exports everything service stacks need as parameters:

| Output | Description |
|--------|-------------|
| `ClusterArn` | ECS Cluster ARN |
| `ListenerArn` | ALB Listener ARN |
| `AlbSgId` | ALB Security Group ID |
| `ExecutionRoleArn` | Shared Execution Role ARN |
| `AlbDnsName` | ALB DNS name (for DNS/CNAME) |
| `ApiRepoUri` | ECR repository URI for API service |
| `UiRepoUri` | ECR repository URI for UI service |
| `VpcId` | VPC ID |
| `PrivateSubnet1` | Private Subnet 1 ID |
| `PrivateSubnet2` | Private Subnet 2 ID |

## Related

- [shared-alb-api](../shared-alb-api/) — API service deployed to this ALB
- [shared-alb-ui](../shared-alb-ui/) — UI service deployed to this ALB

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
