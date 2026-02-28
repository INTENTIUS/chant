# AWS ALB UI Service

UI Fargate service behind a shared Application Load Balancer, with a GitLab CI pipeline for Docker build and CloudFormation deployment.

**Depends on:** [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — deploy the shared infrastructure first.

## Skills

This example includes skills for agent-guided deployment:

| Skill | Purpose |
|-------|---------|
| `chant-gitlab-aws-alb-ui` | Guides the full deploy → verify → teardown workflow for this example |
| `chant-aws` | CloudFormation lifecycle: build, validate, deploy, change sets, rollback |
| `chant-gitlab` | GitLab CI/CD lifecycle: build, validate, push, monitor pipelines |

> **Using Claude Code?** The skills in `.claude/skills/` guide your agent
> through the full deploy → verify → teardown workflow. Just ask:
>
> ```
> Deploy the gitlab-aws-alb-ui example to my AWS account.
> ```

## What this produces

- **AWS** (`templates/template.json`): CloudFormation template with 7 resources and 9 parameters
- **GitLab** (`.gitlab-ci.yml`): 2-stage pipeline (build Docker image + deploy CF stack)

## Source files

| File | Lexicon | Purpose |
|------|---------|---------|
| `src/params.ts` | AWS | CloudFormation parameters for shared ALB stack outputs |
| `src/service.ts` | AWS | `FargateService` composite — task def, ECS service, ALB rule, SG, log group |
| `src/tags.ts` | AWS | Default resource tags |
| `src/pipeline.ts` | GitLab | 2-stage pipeline: build Docker image, deploy CloudFormation |

## Service routing

- **Path pattern:** `/` and `/*`
- **Listener rule priority:** 200
- Traffic reaches the Fargate service via the shared ALB from the infra stack.

## Prerequisites

- [ ] [Bun](https://bun.sh)
- [ ] `shared-alb` infra stack deployed (see [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/))
- [ ] AWS account with ECS, ECR, CloudFormation permissions
- [ ] GitLab project with Docker-in-Docker runner

**Required CI/CD variables** (GitLab > Settings > CI/CD > Variables):

| Variable | Description | Masked |
|----------|-------------|--------|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |
| `AWS_ACCOUNT_ID` | AWS account ID (for ECR URL) | No |

**Local verification** (build, lint, test) requires only Bun — no AWS account needed.

## Local verification

```bash
bun run build
```

## Deploy

1. **Build both outputs**:

   ```bash
   bun run build:aws
   bun run build:gitlab
   ```

2. **Add your app** — add a `Dockerfile` and application code. The `build-image` job runs `docker build .` from the repo root.

3. **Push to GitLab**:

   ```bash
   git add .gitlab-ci.yml templates/ Dockerfile
   git commit -m "Initial pipeline"
   git push
   ```

4. **Pipeline runs automatically** — builds the Docker image, pushes to ECR, fetches `shared-alb` stack outputs, and deploys the service CF stack.

## Verify

```bash
aws cloudformation describe-stacks --stack-name alb-ui --query 'Stacks[0].StackStatus'
aws ecs describe-services --cluster <ClusterArn> --services alb-ui
# Visit http://<AlbDnsName>/
```

## Teardown

Delete api and ui stacks before the infra stack — order matters:

```bash
aws cloudformation delete-stack --stack-name alb-api
aws cloudformation delete-stack --stack-name alb-ui
aws cloudformation wait stack-delete-complete --stack-name alb-api
aws cloudformation wait stack-delete-complete --stack-name alb-ui

# Then delete infra
aws cloudformation delete-stack --stack-name shared-alb
aws cloudformation wait stack-delete-complete --stack-name shared-alb
```

## Related examples

- [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — Shared infrastructure (deploy first)
- [gitlab-aws-alb-api](../gitlab-aws-alb-api/) — API Fargate service (sibling)
- [flyway-postgresql-gitlab-aws-rds](../flyway-postgresql-gitlab-aws-rds/) — AWS RDS + Flyway + GitLab
