# AWS Shared ALB Infrastructure

Shared AWS infrastructure for the ALB service trilogy: VPC, Application Load Balancer, ECS cluster, and ECR repositories — deployed via a GitLab CI pipeline.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws` and `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI/CD lifecycle: build, validate, push, monitor pipelines |
| `chant-aws` | `@intentius/chant-lexicon-aws` | CloudFormation lifecycle: build, validate, change sets, rollback |

> **Using Claude Code?** This example deploys through GitLab CI, not directly. Ask:
>
> ```
> Set up the gitlab-aws-alb-infra example for GitLab CI deployment.
> ```

## What this produces

- **AWS** (`templates/template.json`): CloudFormation template with 24 resources and 10 stack outputs
- **GitLab** (`.gitlab-ci.yml`): Single-stage deploy pipeline using `aws cloudformation deploy`

## Source files

| File | Lexicon | Purpose |
|------|---------|---------|
| `src/network.ts` | AWS | VPC with 2 public + 2 private subnets, IGW, NAT gateway |
| `src/alb.ts` | AWS | Application Load Balancer, ECS cluster, execution role |
| `src/ecr.ts` | AWS | ECR repositories (`alb-api`, `alb-ui`) |
| `src/outputs.ts` | AWS | CloudFormation stack outputs for service stacks |
| `src/tags.ts` | AWS | Default resource tags |
| `src/pipeline.ts` | GitLab | Deploy job using `aws cloudformation deploy` |

## Stack outputs

The infra stack exports these values for the api and ui service stacks:

| Output | Description |
|--------|-------------|
| `ClusterArn` | ECS cluster ARN |
| `ListenerArn` | ALB listener ARN |
| `AlbSgId` | ALB security group ID |
| `ExecutionRoleArn` | Shared ECS execution role ARN |
| `AlbDnsName` | ALB DNS name (your app's URL) |
| `VpcId` | VPC ID |
| `PrivateSubnet1` | First private subnet |
| `PrivateSubnet2` | Second private subnet |
| `ApiRepoUri` | ECR repo URI for API service |
| `UiRepoUri` | ECR repo URI for UI service |

## Prerequisites

- [ ] [Bun](https://bun.sh)
- [ ] [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) >= 2.x
- [ ] AWS account with CloudFormation, ECS, ECR, VPC, ELB permissions
- [ ] GitLab project with CI/CD enabled

**Required CI/CD variables** (GitLab > Settings > CI/CD > Variables):

| Variable | Description | Masked |
|----------|-------------|--------|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |

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

2. **Push to GitLab** — commit `templates/template.json` and `.gitlab-ci.yml`:

   ```bash
   git add .gitlab-ci.yml templates/
   git commit -m "Initial pipeline"
   git push
   ```

3. **Pipeline runs automatically** on pushes to the default branch, deploying the `shared-alb` CloudFormation stack.

## Verify

```bash
aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].StackStatus'
aws cloudformation describe-stacks --stack-name shared-alb --query 'Stacks[0].Outputs'
```

## Teardown

Delete service stacks first, then infra — order matters:

```bash
# Delete api and ui stacks first (if deployed)
aws cloudformation delete-stack --stack-name shared-alb-api
aws cloudformation delete-stack --stack-name shared-alb-ui
aws cloudformation wait stack-delete-complete --stack-name shared-alb-api
aws cloudformation wait stack-delete-complete --stack-name shared-alb-ui

# Empty ECR repos (CloudFormation cannot delete repos containing images)
aws ecr delete-repository --repository-name alb-api --force
aws ecr delete-repository --repository-name alb-ui --force

# Then delete the infra stack
aws cloudformation delete-stack --stack-name shared-alb
aws cloudformation wait stack-delete-complete --stack-name shared-alb
```

> **Re-deploying after a partial teardown:** If ECR repos `alb-api`/`alb-ui` already exist from a previous run, the stack will fail with a `ResourceExistenceCheck` error. Delete the orphaned repos with `aws ecr delete-repository --repository-name <name> --force` before re-deploying.

## Related examples

- [gitlab-aws-alb-api](../gitlab-aws-alb-api/) — API Fargate service (depends on this stack)
- [gitlab-aws-alb-ui](../gitlab-aws-alb-ui/) — UI Fargate service (depends on this stack)
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s
