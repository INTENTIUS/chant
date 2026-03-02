# Shared ALB — UI Service

Fargate service for `/` routes, deployed to a shared ALB.

## Quick Start

```bash
# Build the service template
chant build src --lexicon aws -o template.json

# Deploy with shared ALB outputs
aws cloudformation deploy \
  --template-file template.json \
  --stack-name ui-service \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    clusterArn=arn:aws:ecs:... \
    listenerArn=arn:aws:elasticloadbalancing:... \
    albSgId=sg-... \
    executionRoleArn=arn:aws:iam:... \
    vpcId=vpc-... \
    privateSubnet1=subnet-... \
    privateSubnet2=subnet-... \
    image=123456789012.dkr.ecr.us-east-1.amazonaws.com/alb-ui:latest
```

## What It Does

Deploys 7 CloudFormation resources via `FargateService`:

- **Task Role** — application-level IAM permissions
- **Log Group** — CloudWatch Logs with 30-day retention
- **Task Definition** — Fargate task running the UI container on port 80
- **Task Security Group** — allows inbound from ALB SG only
- **Target Group** — health check on `/`
- **Listener Rule** — routes `/` and `/*` at priority 200
- **ECS Service** — 2 Fargate tasks in private subnets

## Related

- [shared-alb](../shared-alb/) — the shared ALB infrastructure this service deploys to
- [shared-alb-api](../shared-alb-api/) — the API service on the same ALB

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
