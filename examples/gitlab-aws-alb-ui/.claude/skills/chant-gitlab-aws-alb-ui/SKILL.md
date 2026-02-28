---
skill: chant-gitlab-aws-alb-ui
description: Deploy and manage the UI Fargate service example
user-invocable: true
---

# GitLab + AWS ALB UI Service

This project defines an AWS Fargate service behind a shared ALB and a GitLab
CI pipeline (Docker build + CloudFormation deploy) — all in TypeScript using
two chant lexicons.

**Depends on:** [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — deploy
the infra stack first.

See also the lexicon skills `chant-aws` and `chant-gitlab` for operational
playbooks.

## Project layout

- `src/params.ts` — CloudFormation parameters (shared stack outputs)
- `src/service.ts` — FargateService composite (task def, service, ALB rule, SG, logs)
- `src/tags.ts` — default resource tags
- `src/pipeline.ts` — GitLab CI 2-stage pipeline (build image + deploy)
- `src/chant.config.json` — lint configuration

## Local verification (no AWS required)

```bash
bun run build              # generates CF template + .gitlab-ci.yml
bun run build:aws          # CloudFormation only
bun run build:gitlab       # GitLab CI only
```

Run tests from the repo root:

```bash
bun test examples/gitlab-aws-alb-ui/
```

## Deploy workflow

### Prerequisites

- `shared-alb` infra stack deployed (see gitlab-aws-alb-infra)
- AWS account with ECS, ECR, CloudFormation permissions
- GitLab project with Docker-in-Docker runner
- CI/CD variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, AWS_ACCOUNT_ID

### Steps

1. Build: `bun run build`
2. Add your Dockerfile and application code
3. Commit `templates/template.json`, `.gitlab-ci.yml`, Dockerfile to GitLab
4. Push to default branch — pipeline builds Docker image, pushes to ECR, deploys CF stack
5. UI available at ALB DNS name under `/` path

## Teardown

Delete api and ui stacks before the infra stack — order matters:

```bash
aws cloudformation delete-stack --stack-name alb-api
aws cloudformation delete-stack --stack-name alb-ui
aws cloudformation wait stack-delete-complete --stack-name alb-api
aws cloudformation wait stack-delete-complete --stack-name alb-ui
aws cloudformation delete-stack --stack-name shared-alb
aws cloudformation wait stack-delete-complete --stack-name shared-alb
```

## Troubleshooting

- Build job fails → check Docker-in-Docker runner and ECR login
- Deploy job fails → check that `shared-alb` stack outputs are available
- Service not healthy → check ECS task logs: `aws ecs describe-tasks`
- ALB 503 → check target group health: `aws elbv2 describe-target-health`
