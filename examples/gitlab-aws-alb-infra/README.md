# AWS Shared ALB — Infra Pipeline

Deploys the shared ALB CloudFormation stack (VPC, ALB, ECS cluster, ECR repos) from GitLab CI.

## What this generates

```yaml
stages:
  - deploy

deploy-infra:
  stage: deploy
  image:
    name: amazon/aws-cli:latest
  script:
    - aws cloudformation deploy --template-file templates/template.json --stack-name shared-alb --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

## Required CI/CD variables

Set these in **GitLab > Settings > CI/CD > Variables**:

| Variable | Description | Masked |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |

The `aws` CLI picks up these variables automatically. No `AWS_ACCOUNT_ID` is needed — the infra stack doesn't reference it.

## Deploy

### 1. Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

### 2. Add the CloudFormation template

Place your built `template.json` at `templates/template.json` in this repo. The template is the output of the `shared-alb` chant AWS example.

### 3. Push to GitLab

```bash
git add .gitlab-ci.yml templates/
git commit -m "Initial pipeline"
git push
```

The pipeline runs automatically on pushes to the default branch.

## What the stack creates

- VPC with 2 public + 2 private subnets, NAT gateway
- Application Load Balancer with default 404 listener
- ECS cluster + shared execution role
- ECR repositories: `alb-api` and `alb-ui`

Stack outputs (`ClusterArn`, `ListenerArn`, `AlbSgId`, etc.) are consumed by the service pipelines via `aws cloudformation describe-stacks`.

## Related projects

- [gitlab-aws-alb-api](https://gitlab.com/lex002/gitlab-aws-alb-api) — API service pipeline
- [gitlab-aws-alb-ui](https://gitlab.com/lex002/gitlab-aws-alb-ui) — UI service pipeline
