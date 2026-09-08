# AWS ALB Services

> **New to chant?** Start with the [golden teaching example](../getting-started/) — synthesis → lint → Ops → the lifecycle dial over one set of declarations — then come back here for a production-shaped deployment.

Two Fargate services, API and UI, behind one shared Application Load Balancer, with a GitLab CI pipeline that builds both Docker images and deploys the CloudFormation stack that holds both services.

**Depends on:** [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — deploy the shared infrastructure first.

## Architecture

```
ALB (shared-alb stack)
  ├── Listener rule: /api and /api/* (priority 100)
  │     └── Target group → Fargate task (port 8080)
  │           └── ECR image: alb-api (built and pushed by this pipeline)
  └── Listener rule: / and /* (priority 200, catch-all)
        └── Target group → Fargate task (port 80)
              └── ECR image: alb-ui (built and pushed by this pipeline)
```

Both services are declared in one `src/`, so one `chant build` produces one template and one `aws cloudformation deploy` applies both. The priorities are what orders the two listener rules: the API's `/api` prefix is evaluated first and the UI's `/*` catches everything else.

**Where the AWS resources come from:** `src/params.ts`, `src/services.ts` and `src/tags.ts` began as copies of `lexicons/aws/examples/shared-alb-api/src/` and `lexicons/aws/examples/shared-alb-ui/src/`, and have since diverged from both: the two services share one set of ALB parameters here, the container image parameters are named `apiImage` and `uiImage` so they can coexist in one template, and `defaultTags` no longer carries a per-service `Service` tag. This directory synthesizes the two `FargateService` templates itself; it does not import the lexicon examples. What it adds on top of the copies is `src/pipeline.ts` and `src/ci.ts`, the GitLab CI pipeline that builds both Docker images and deploys the stack, and `src/chant.config.json`, which turns COR004 off under the strict lint preset. `lexicons/aws/examples/multi-service-alb/` is the closest lexicon-side counterpart to the shape here: two `FargateService` calls in one stack, without the pipeline. Sync is by hand.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws` and `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI/CD lifecycle: build, validate, push, monitor pipelines |
| `chant-aws` | `@intentius/chant-lexicon-aws` | CloudFormation lifecycle: build, validate, change sets, rollback |

> **Using Claude Code?** This example deploys through GitLab CI, not directly. Ask:
>
> ```
> Set up the gitlab-aws-alb-services example for GitLab CI deployment.
> ```

## What this produces

- **AWS** (`templates/template.json`): CloudFormation template with 14 resources and 10 parameters — 7 resources per `FargateService` (task role, log group, task definition, task security group, target group, listener rule, ECS service)
- **GitLab** (`.gitlab-ci.yml`): 2-stage pipeline — two parallel image builds, then one deploy job that waits on both

## Source files

| File | Lexicon | Purpose |
|------|---------|---------|
| `src/params.ts` | AWS | CloudFormation parameters for shared ALB stack outputs |
| `src/services.ts` | AWS | Two `FargateService` composites and their image parameters |
| `src/tags.ts` | AWS | Default resource tags |
| `src/ci.ts` | GitLab | Runner plumbing the three jobs share: images, dind service, branch rule, ECR login |
| `src/pipeline.ts` | GitLab | 2-stage pipeline: build both Docker images, deploy CloudFormation |
| `Dockerfile.api` | — | API container (`mccutchen/go-httpbin` on port 8080) |
| `Dockerfile.ui` | — | UI container (nginx on port 80) |

## Service routing

| Service | Path pattern | Priority | Container port | Health check |
|---------|--------------|----------|----------------|--------------|
| API | `/api` and `/api/*` | 100 | 8080 | `/api/get` |
| UI | `/` and `/*` | 200 | 80 | default |

Traffic reaches both Fargate services via the shared ALB from the infra stack.

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
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

**Local verification** (build, lint, test) requires only Node.js — no AWS account needed.

## Local verification

```bash
npx chant build src --lexicon aws -o templates/template.json
npx chant build src --lexicon gitlab -o .gitlab-ci.yml
```

## Deploy

1. **Build both outputs**:

   ```bash
   npx chant build src --lexicon aws -o templates/template.json
   npx chant build src --lexicon gitlab -o .gitlab-ci.yml
   ```

2. **Add your apps** — replace `Dockerfile.api` and `Dockerfile.ui` with your own. The API container must listen on **port 8080** and serve a health check at **`/api/get`**; the UI container must listen on **port 80**. Both jobs run `docker build` from the repo root with `-f`, so application code sits next to the Dockerfiles.

3. **Push to GitLab**:

   ```bash
   git add .gitlab-ci.yml templates/ Dockerfile.api Dockerfile.ui
   git commit -m "Initial pipeline"
   git push
   ```

4. **Pipeline runs automatically** — builds and pushes both images to ECR, fetches `shared-alb` stack outputs, and deploys the `shared-alb-services` CF stack with both image URIs.

## Verify

```bash
aws cloudformation describe-stacks --stack-name shared-alb-services --query 'Stacks[0].StackStatus'
aws ecs list-services --cluster <ClusterArn>
# Visit http://<AlbDnsName>/api and http://<AlbDnsName>/
```

## Teardown

```bash
aws cloudformation delete-stack --stack-name shared-alb-services
aws cloudformation wait stack-delete-complete --stack-name shared-alb-services
```

Delete this stack before deleting the infra stack.

## Security hardening

- **SG: ALB → Fargate only** — each task security group allows inbound only from the ALB security group on that service's container port; no direct inbound from `0.0.0.0/0`
- **ECR image scanning** — `ScanOnPush: true` on both ECR repos; critical vulnerabilities visible in the ECR console before deployment
- **No static credentials** — the pipeline uses `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` CI/CD variables (masked); credentials are never embedded in source files or Docker images
- **Cost:** See [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/#cost-estimate) for shared infra costs (~$48/mo). Fargate task cost depends on task size (default: 0.25 vCPU / 0.5Gi per service).

## Related examples

- [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — Shared infrastructure and the `alb-deploy` Op (deploy first)
- [lexicons/aws/examples/multi-service-alb](../../lexicons/aws/examples/multi-service-alb/) — The same two services with the ALB and VPC in the same stack, no pipeline

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
