# Flyway + PostgreSQL + GitLab CI + AWS RDS

A cross-lexicon example combining **three** lexicons: AWS (RDS infrastructure), Flyway (migration config), and GitLab (CI pipeline). The GitLab pipeline deploys the CloudFormation stack then runs Flyway migrations against the new RDS endpoint.

## Source Files

| File | Lexicon | Description |
|------|---------|-------------|
| `src/network.ts` | aws | VpcDefault composite — foundational networking |
| `src/database.ts` | aws | RdsInstance composite — consumes VPC outputs |
| `src/params.ts` | aws | CloudFormation Parameters (environment, dbPasswordSsmPath) |
| `src/outputs.ts` | aws | Stack Outputs (DbEndpoint) |
| `src/tags.ts` | aws | Default resource tags |
| `src/migrations.ts` | flyway | FlywayProject, FlywayConfig, Environment |
| `src/pipeline.ts` | gitlab | 2-stage CI pipeline (deploy → migrate) |
| `sql/migrations/` | — | SQL migration files (V1–V3) |

## What this produces

### `chant build src --lexicon aws` → CloudFormation template (20 resources)

- VPC with 2 public + 2 private subnets, IGW, NAT gateway, route tables (17 resources)
- RDS PostgreSQL instance in public subnets, publicly accessible, with security group (3 resources)
- Parameters: `environment`, `dbPasswordSsmPath` (SSM SecureString)
- Output: `DbEndpoint`

### `chant build src --lexicon flyway` → `flyway.toml`

```toml
[flyway]
databaseType = "postgresql"
locations = ["filesystem:sql/migrations"]

[environments.deploy]
url = "jdbc:postgresql://${env.DB_HOST}:5432/myapp"
password = "${env.DB_PASSWORD}"
```

The `${env.*}` references use Flyway's built-in environment variable resolution. The GitLab pipeline sets `DB_HOST` and `DB_PASSWORD` from CF stack outputs and SSM.

### `chant build src --lexicon gitlab` → `.gitlab-ci.yml`

A 2-stage pipeline:

1. **deploy** — `deploy-infra`: deploys the CloudFormation stack using `aws cloudformation deploy`
2. **migrate** — `run-migrations`: extracts DB endpoint from stack outputs, fetches password from SSM, runs `flyway migrate`

## Required CI/CD variables

Set these in **GitLab > Settings > CI/CD > Variables**:

| Variable | Description | Masked |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key | No |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | Yes |
| `AWS_DEFAULT_REGION` | AWS region (e.g. `us-east-1`) | No |

The IAM user/role needs permissions for CloudFormation, EC2 (VPC), RDS, and SSM Parameter Store.

## Deploy

### 1. Create the SSM parameter

The RDS instance reads its master password from SSM at deploy time. Create it once:

```bash
./setup.sh
```

This generates a random password and stores it as a SecureString at `/myapp/dev/db-password`. To use a custom path:

```bash
./setup.sh /myapp/prod/db-password
```

### 2. Build all artifacts

```bash
chant build src --lexicon aws --output templates/template.json
chant build src --lexicon flyway --output flyway.toml
chant build src --lexicon gitlab --output .gitlab-ci.yml
```

### 3. Validate

Lint the source:

```bash
chant lint src
```

Optionally validate `.gitlab-ci.yml` against your GitLab instance:

```bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.com/api/v4/ci/lint" \
  --data "{\"content\": \"$(cat .gitlab-ci.yml)\"}"
```

### 4. Push to GitLab

```bash
git add .gitlab-ci.yml templates/template.json flyway.toml sql/
git commit -m "Initial pipeline"
git push
```

The pipeline runs automatically on pushes to the default branch. The `deploy-infra` job deploys the CF stack, then `run-migrations` connects to the new RDS endpoint and runs Flyway migrations.

### 5. Monitor the pipeline

- **GitLab UI**: project → CI/CD → Pipelines
- **API**: `curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines?per_page=5"`

### Retry / Cancel

- Retry a failed job: GitLab UI → click Retry, or `curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/retry"`
- Cancel a running pipeline: `curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/cancel"`
- Check job logs: GitLab UI → CI/CD → Jobs → click the job

## Build commands (quick reference)

```bash
# Build all lexicons
bun run build

# Build individual lexicons
bun run build:aws      # CloudFormation JSON
bun run build:flyway   # flyway.toml
bun run build:gitlab   # .gitlab-ci.yml

# Lint
bun run lint
```
