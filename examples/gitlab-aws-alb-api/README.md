# AWS Shared ALB — Cross-Lexicon API Service Example

A cross-lexicon example that defines both the **AWS Fargate service infrastructure** (7 CF resources) and the **GitLab CI pipeline** (Docker build + CF deploy) — all in TypeScript.

This demonstrates chant's multi-lexicon capability: a single `src/` directory imports from both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-gitlab`, and builds to two separate outputs.

## Source files

| File | Lexicon | Description |
|------|---------|-------------|
| `src/params.ts` | aws | CF parameters for shared ALB stack outputs |
| `src/service.ts` | aws | `FargateService` composite — task def, service, ALB rule, security group, log group |
| `src/tags.ts` | aws | Default resource tags |
| `src/pipeline.ts` | gitlab | 2-stage pipeline: build Docker image + deploy CF stack |

## What this produces

### `chant build src --lexicon aws` → CloudFormation template (7 resources, 9 parameters)

- Fargate task definition, ECS service, and task role
- Target group + ALB listener rule for `/api` and `/api/*` (priority 100)
- Security group for the ECS tasks
- CloudWatch log group
- Parameters: `clusterArn`, `listenerArn`, `albSgId`, `executionRoleArn`, `vpcId`, `privateSubnet1`, `privateSubnet2`, `image`, `environment`

### `chant build src --lexicon gitlab` → `.gitlab-ci.yml`

A 2-stage pipeline:

1. **build** — `build-image`: builds Docker image with Docker-in-Docker, pushes to ECR (`alb-api`), tags `:latest` on default branch
2. **deploy** — `deploy-service`: fetches shared ALB stack outputs via `aws cloudformation describe-stacks`, maps them to CF parameter overrides, deploys `templates/template.json`

## Required CI/CD variables

Set these in **GitLab > Settings > CI/CD > Variables**:

| Variable | Description | Masked |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |
| `AWS_ACCOUNT_ID` | AWS account ID (used to construct ECR URL) | No |

## Prerequisites

The **shared-alb infra stack** must be deployed first — it creates the VPC, ALB, ECS cluster, and ECR repos. See [gitlab-aws-alb-infra](../gitlab-aws-alb-infra).

## Deploy

### 1. Build both outputs

```bash
chant build src --lexicon aws --output templates/template.json
chant build src --lexicon gitlab --output .gitlab-ci.yml
```

### 2. Add your app

Add a `Dockerfile` and application code. The `build-image` job runs `docker build .` from the repo root.

### 3. Push to GitLab

```bash
git add .
git commit -m "Initial pipeline"
git push
```

The deploy job fetches outputs from the `shared-alb` stack and passes them as `--parameter-overrides` to `aws cloudformation deploy`.

## Related examples

- [gitlab-aws-alb-infra](../gitlab-aws-alb-infra) — Shared infra (deploy first)
- [gitlab-aws-alb-ui](../gitlab-aws-alb-ui) — UI Fargate service (cross-lexicon)
