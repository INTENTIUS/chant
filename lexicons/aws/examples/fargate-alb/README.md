# Fargate ALB

A Fargate service behind an Application Load Balancer, consuming a VPC — demonstrates composability between `VpcDefault` and `FargateAlb` composites.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 28 CloudFormation resources:

**Network layer (17 resources via VpcDefault):**
- VPC, Internet Gateway, 2 public + 2 private subnets, NAT Gateway, route tables, and associations

**Service layer (11 resources via FargateAlb):**
- **ECS Cluster** — Fargate cluster
- **Execution Role** — ECR pull + CloudWatch Logs write permissions
- **Task Role** — application-level permissions (none in this example)
- **Log Group** — CloudWatch log group with 30-day retention
- **Task Definition** — Fargate task with nginx container, awsvpc networking
- **ALB Security Group** — allows inbound HTTP on port 80
- **Task Security Group** — allows inbound on container port from ALB SG only
- **Application Load Balancer** — internet-facing, placed in public subnets
- **Target Group** — IP-based targeting (required for awsvpc)
- **Listener** — forwards HTTP traffic to the target group
- **ECS Service** — 2 Fargate tasks in private subnets with ALB health check grace period

## Project Structure

```
src/
├── network.ts    # VpcDefault composite — foundational networking
└── service.ts    # FargateAlb composite — consumes VPC outputs
```

## Patterns Demonstrated

1. **Composite composability** — `FargateAlb` consumes `VpcDefault` outputs (`VpcId`, subnet IDs) as props
2. **Separation of concerns** — network and service layers are defined in separate files
3. **Cross-reference wiring** — subnet and VPC IDs flow from one composite to another via attribute references
4. **Secure defaults** — tasks run in private subnets, ALB in public subnets, security groups restrict traffic flow
