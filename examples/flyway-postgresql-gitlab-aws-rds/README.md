# Flyway + PostgreSQL + GitLab CI + AWS RDS

A cross-lexicon example combining **three** lexicons: AWS (RDS infrastructure), Flyway (migration config), and GitLab (CI pipeline). The GitLab pipeline deploys the CloudFormation stack then runs Flyway migrations against the new RDS endpoint.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, `chant init --lexicon flyway`, and `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI/CD lifecycle: build, validate, push, monitor pipelines |
| `chant-aws` | `@intentius/chant-lexicon-aws` | CloudFormation lifecycle: build, validate, change sets, rollback |
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway migration lifecycle: build, validate, migrate, repair |

> **Using Claude Code?** This example deploys through GitLab CI, not directly. Ask:
>
> ```
> Set up the flyway-postgresql-gitlab-aws-rds example for GitLab CI deployment.
> ```

## What this produces

- **AWS** (`templates/template.json`): CloudFormation template with 20 resources (17 VPC + 3 RDS)
- **Flyway** (`flyway.toml`): Project config with deploy environment using `${env.*}` variable resolution
- **GitLab** (`.gitlab-ci.yml`): 2-stage pipeline (deploy infrastructure → run migrations)

## Source files

| File | Lexicon | Purpose |
|------|---------|---------|
| `src/network.ts` | AWS | VpcDefault composite — VPC, subnets, IGW, NAT gateway |
| `src/database.ts` | AWS | RdsInstance composite — PostgreSQL in public subnets |
| `src/params.ts` | AWS | CloudFormation parameters (environment, dbPasswordSsmPath, dbIngressCidr) |
| `src/outputs.ts` | AWS | Stack outputs (DbEndpoint) |
| `src/tags.ts` | AWS | Default resource tags |
| `src/migrations.ts` | Flyway | FlywayProject, FlywayConfig, deploy Environment |
| `src/pipeline.ts` | GitLab | 2-stage pipeline: deploy-infra → run-migrations |
| `sql/migrations/` | — | SQL migration files (V1–V3) |

## How cross-lexicon build works

Each `chant build --lexicon <name>` invocation selects only the resources belonging to that lexicon. The Flyway config uses `${env.DB_HOST}` and `${env.DB_PASSWORD}` — resolved at runtime by the GitLab pipeline, which extracts the RDS endpoint from CF stack outputs and the password from SSM.

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) >= 2.x
- [ ] AWS account with CloudFormation, EC2 (VPC), RDS, SSM permissions
- [ ] GitLab project with CI/CD enabled

**Required CI/CD variables** (GitLab > Settings > CI/CD > Variables):

| Variable | Description | Masked |
|----------|-------------|--------|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |

**Local verification** (build, lint, test) requires only Node.js — no AWS account needed.

## Local verification

```bash
npx chant build src --lexicon aws -o templates/template.json
npx chant build src --lexicon flyway -o flyway.toml
npx chant build src --lexicon gitlab -o .gitlab-ci.yml
npx chant lint src
```

## Deploy

1. **Create SSM parameter** — stores the RDS master password as a SecureString:

   ```bash
   ./setup.sh                           # default: /myapp/dev/db-password
   ./setup.sh /myapp/prod/db-password   # custom path
   ```

2. **Build all outputs**:

   ```bash
   npx chant build src --lexicon aws -o templates/template.json
   npx chant build src --lexicon flyway -o flyway.toml
   npx chant build src --lexicon gitlab -o .gitlab-ci.yml
   ```

3. **Push to GitLab**:

   ```bash
   git add .gitlab-ci.yml templates/template.json flyway.toml sql/
   git commit -m "Initial pipeline"
   git push
   ```

4. **Pipeline runs automatically** — `deploy-infra` deploys the CF stack, then `run-migrations` extracts the DB endpoint, fetches the password from SSM, and runs `flyway migrate`.

## Verify

```bash
aws cloudformation describe-stacks --stack-name flyway-rds --query 'Stacks[0].StackStatus'
aws cloudformation describe-stacks --stack-name flyway-rds --query 'Stacks[0].Outputs'
# Check pipeline in GitLab UI: CI/CD → Pipelines
```

## Teardown

```bash
aws cloudformation delete-stack --stack-name flyway-rds
aws cloudformation wait stack-delete-complete --stack-name flyway-rds

# Optionally delete the SSM parameter
aws ssm delete-parameter --name /myapp/dev/db-password
```

## Related examples

- [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — AWS + GitLab shared ALB infrastructure
- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
