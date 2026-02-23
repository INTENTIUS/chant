# AWS Shared ALB — UI Service Pipeline

Builds a Docker image, pushes to ECR, and deploys the UI Fargate service stack from GitLab CI.

## What this generates

A 2-stage pipeline:

1. **build** — `build-image`: builds Docker image, pushes to ECR (`alb-ui`)
2. **deploy** — `deploy-service`: fetches shared ALB stack outputs, deploys the UI CloudFormation stack with parameter overrides

## Required CI/CD variables

Set these in **GitLab > Settings > CI/CD > Variables**:

| Variable | Description | Masked |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |
| `AWS_ACCOUNT_ID` | AWS account ID (used in ECR URL) | No |

The ECR URL is constructed as `$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/alb-ui`.

## Prerequisites

The **shared-alb infra stack** must be deployed first. It creates the VPC, ALB, ECS cluster, and ECR repos that this pipeline depends on. See [gitlab-aws-alb-infra](https://gitlab.com/lex002/gitlab-aws-alb-infra).

## Deploy

### 1. Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

### 2. Add your app

Add a `Dockerfile` and application code to this repo. The `build-image` job runs `docker build .` from the repo root.

### 3. Add the CloudFormation template

Place the built `template.json` at `templates/template.json`. This is the output of the `shared-alb-ui` chant AWS example.

### 4. Push to GitLab

```bash
git add .
git commit -m "Initial pipeline"
git push
```

## How it works

### Build stage

- Uses `docker:27-cli` with Docker-in-Docker (`docker:27-dind`)
- Installs `aws-cli` via `apk` (Alpine package)
- Authenticates to ECR: `aws ecr get-login-password | docker login`
- Tags with `$CI_COMMIT_REF_SLUG`; also tags `:latest` on the default branch

### Deploy stage

- Fetches shared ALB outputs: `aws cloudformation describe-stacks --stack-name shared-alb`
- Maps PascalCase outputs to camelCase CF parameters via `jq`
- Appends `:<tag>` to the ECR repo URI for the `image` parameter
- Runs `aws cloudformation deploy` with `--parameter-overrides`

### Cross-stack parameter mapping

| Infra stack output | Service parameter |
|---|---|
| `ClusterArn` | `clusterArn` |
| `ListenerArn` | `listenerArn` |
| `AlbSgId` | `albSgId` |
| `ExecutionRoleArn` | `executionRoleArn` |
| `VpcId` | `vpcId` |
| `PrivateSubnet1` | `privateSubnet1` |
| `PrivateSubnet2` | `privateSubnet2` |
| `UiRepoUri` + `:$CI_COMMIT_REF_SLUG` | `image` |

## Related projects

- [gitlab-aws-alb-infra](https://gitlab.com/lex002/gitlab-aws-alb-infra) — Shared infra pipeline (deploy first)
- [gitlab-aws-alb-api](https://gitlab.com/lex002/gitlab-aws-alb-api) — API service pipeline
