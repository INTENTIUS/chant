---
skill: chant-gitlab-aws-alb-infra
description: Deploy and manage the shared ALB infrastructure example
user-invocable: true
---

# GitLab + AWS Shared ALB Infrastructure

This project defines shared AWS infrastructure (VPC, ALB, ECS cluster, ECR
repos) and a GitLab CI pipeline to deploy it — all in TypeScript using two
chant lexicons.

See also the lexicon skills `chant-aws` and `chant-gitlab` for operational
playbooks.

## Project layout

- `src/network.ts` — VPC with public/private subnets, IGW, NAT
- `src/alb.ts` — Application Load Balancer, ECS cluster, execution role
- `src/ecr.ts` — ECR repositories (alb-api, alb-ui)
- `src/outputs.ts` — CloudFormation stack outputs
- `src/tags.ts` — default resource tags
- `src/pipeline.ts` — GitLab CI deploy job
- `src/chant.config.json` — lint configuration

## Local verification (no AWS required)

```bash
bun run build              # generates CF template + .gitlab-ci.yml
bun run build:aws          # CloudFormation only
bun run build:gitlab       # GitLab CI only
```

Run tests from the repo root:

```bash
bun test examples/gitlab-aws-alb-infra/
```

## Deploy workflow

### Prerequisites

- AWS account with CloudFormation + ECS permissions
- GitLab project with CI/CD enabled
- CI/CD variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION

### Steps

1. Build: `bun run build`
2. Commit `templates/template.json` and `.gitlab-ci.yml` to GitLab
3. Push to default branch — pipeline deploys the `shared-alb` CF stack
4. Stack outputs (ClusterArn, ListenerArn, etc.) are consumed by api and ui stacks

## Teardown

Delete in reverse order: api stack, ui stack, then infra stack.

```bash
aws cloudformation delete-stack --stack-name alb-api
aws cloudformation delete-stack --stack-name alb-ui
aws cloudformation wait stack-delete-complete --stack-name alb-api
aws cloudformation wait stack-delete-complete --stack-name alb-ui
aws cloudformation delete-stack --stack-name shared-alb
aws cloudformation wait stack-delete-complete --stack-name shared-alb
```

## Troubleshooting

- Pipeline fails with AccessDenied → check CI/CD variables and IAM permissions
- Stack creation fails → check CloudFormation events: `aws cloudformation describe-stack-events --stack-name shared-alb`
- NAT gateway limit → request quota increase for Elastic IPs
