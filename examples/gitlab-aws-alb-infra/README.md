# AWS Shared ALB — Cross-Lexicon Infra Example

A cross-lexicon example that defines both **AWS infrastructure** (VPC, ALB, ECS cluster, ECR repos) and the **GitLab CI pipeline** that deploys it — all in TypeScript.

This demonstrates chant's multi-lexicon capability: a single `src/` directory imports from both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-gitlab`, and builds to two separate outputs.

## Source files

| File | Lexicon | Description |
|------|---------|-------------|
| `src/network.ts` | aws | VPC with 2 public + 2 private subnets, NAT gateway |
| `src/alb.ts` | aws | Application Load Balancer, ECS cluster, execution role |
| `src/ecr.ts` | aws | ECR repositories (`alb-api`, `alb-ui`) |
| `src/outputs.ts` | aws | CloudFormation stack outputs for service stacks |
| `src/tags.ts` | aws | Default resource tags |
| `src/pipeline.ts` | gitlab | Deploy job using `aws cloudformation deploy` |

## What this produces

### `chant build src --lexicon aws` → CloudFormation template (24 resources, 10 outputs)

- VPC with 2 public + 2 private subnets, IGW, NAT gateway, route tables
- Application Load Balancer with security group and default 404 listener
- ECS cluster + shared execution role
- ECR repositories: `alb-api` and `alb-ui`
- Stack outputs: `ClusterArn`, `ListenerArn`, `AlbSgId`, `ExecutionRoleArn`, `AlbDnsName`, `VpcId`, `PrivateSubnet1`, `PrivateSubnet2`, `ApiRepoUri`, `UiRepoUri`

### `chant build src --lexicon gitlab` → `.gitlab-ci.yml`

```yaml
stages:
  - deploy

deploy-infra:
  stage: deploy
  image:
    name: amazon/aws-cli:latest
    entrypoint:
      - ''
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

No `AWS_ACCOUNT_ID` is needed — the infra stack doesn't reference it.

## Deploy

### 1. Build both outputs

```bash
chant build src --lexicon aws --output templates/template.json
chant build src --lexicon gitlab --output .gitlab-ci.yml
```

### 2. Push to GitLab

```bash
git add .gitlab-ci.yml templates/
git commit -m "Initial pipeline"
git push
```

The pipeline runs automatically on pushes to the default branch. It deploys the CloudFormation stack using the co-located `templates/template.json`.

## Related examples

- [gitlab-aws-alb-api](../gitlab-aws-alb-api) — API Fargate service (cross-lexicon, depends on this stack)
- [gitlab-aws-alb-ui](../gitlab-aws-alb-ui) — UI Fargate service (cross-lexicon, depends on this stack)
