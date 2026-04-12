# Multi-Service ALB

Multiple Fargate services behind a single shared Application Load Balancer — demonstrates the `AlbShared` + `FargateService` composites.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the multi-service-alb example to my AWS account.
> ```

## Quick Start

```bash
npm run build
```

## What It Does

The stack creates 36 CloudFormation resources:

**Network layer (17 resources via VpcDefault):**
- VPC, Internet Gateway, 2 public + 2 private subnets, NAT Gateway, route tables, and associations

**Shared ALB layer (5 resources via AlbShared):**
- **ECS Cluster** — shared Fargate cluster
- **Execution Role** — shared ECR pull + CloudWatch Logs write permissions
- **ALB Security Group** — allows inbound HTTP on port 80
- **Application Load Balancer** — internet-facing, placed in public subnets
- **Listener** — default action returns 404 (routes via listener rules)

**API service (7 resources via FargateService):**
- Task Role, Log Group, Task Definition, Task Security Group, Target Group, Listener Rule (`/api/*`), ECS Service

**Frontend service (7 resources via FargateService):**
- Task Role, Log Group, Task Definition, Task Security Group, Target Group, Listener Rule (`/*`), ECS Service

## Project Structure

```
src/
├── network.ts    # VpcDefault composite
├── shared.ts     # AlbShared composite — shared ALB infrastructure
└── services.ts   # Two FargateService composites — API and frontend
```

## Patterns Demonstrated

1. **Shared ALB** — one ALB, multiple services with independent listener rules
2. **Rule-based routing** — API gets `/api/*`, frontend gets `/*` (catch-all)
3. **Priority ordering** — API at priority 100, frontend at 200 (specific before catch-all)
4. **Composite composability** — `FargateService` consumes `AlbShared` and `VpcDefault` outputs

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
