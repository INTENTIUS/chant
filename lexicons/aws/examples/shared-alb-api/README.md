# Shared ALB — API Service

Fargate service for `/api` routes, deployed to a shared ALB.

## Quick Start

```bash
# Build the service template
chant build src

# Deploy with shared ALB outputs
aws cloudformation deploy \
  --template-file dist/template.json \
  --stack-name api-service \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ClusterArn=arn:aws:ecs:... \
    ListenerArn=arn:aws:elasticloadbalancing:... \
    AlbSgId=sg-... \
    ExecutionRoleArn=arn:aws:iam:... \
    VpcId=vpc-... \
    PrivateSubnet1=subnet-... \
    PrivateSubnet2=subnet-...
```

## What It Does

Deploys 7 CloudFormation resources via `FargateService`:

- **Task Role** — application-level IAM permissions
- **Log Group** — CloudWatch Logs with 30-day retention
- **Task Definition** — Fargate task running the API container on port 3000
- **Task Security Group** — allows inbound from ALB SG only
- **Target Group** — health check on `/api/health`
- **Listener Rule** — routes `/api` and `/api/*` at priority 100
- **ECS Service** — 2 Fargate tasks in private subnets

## Related

- [shared-alb](../shared-alb/) — the shared ALB infrastructure this service deploys to
- [shared-alb-ui](../shared-alb-ui/) — the UI service on the same ALB
