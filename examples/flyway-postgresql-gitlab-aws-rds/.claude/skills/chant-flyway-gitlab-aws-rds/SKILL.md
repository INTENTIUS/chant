---
skill: chant-flyway-gitlab-aws-rds
description: Deploy and manage the Flyway + AWS RDS + GitLab CI example
user-invocable: true
---

# Flyway + PostgreSQL + GitLab CI + AWS RDS

This project combines three chant lexicons in a single `src/` directory:
AWS (RDS infrastructure), Flyway (migration config), and GitLab (CI pipeline).
The GitLab pipeline deploys a CloudFormation stack then runs Flyway migrations
against the new RDS endpoint.

See also the lexicon skills `chant-aws`, `chant-flyway`, and `chant-gitlab`
for operational playbooks.

## Project layout

- `src/network.ts` — VpcDefault composite (VPC, subnets, IGW, NAT)
- `src/database.ts` — RdsInstance composite (PostgreSQL RDS)
- `src/params.ts` — CloudFormation parameters
- `src/outputs.ts` — Stack outputs (DbEndpoint)
- `src/tags.ts` — default resource tags
- `src/migrations.ts` — Flyway project, config, deploy environment
- `src/pipeline.ts` — GitLab CI 2-stage pipeline (deploy → migrate)
- `sql/migrations/` — SQL migration files (V1–V3)
- `setup.sh` — creates SSM SecureString for RDS password
- `src/chant.config.json` — lint configuration

## Local verification (no AWS required)

```bash
bun run build              # generates all three outputs
bun run build:aws          # CloudFormation only (20 resources)
bun run build:flyway       # flyway.toml only
bun run build:gitlab       # .gitlab-ci.yml only
bun run lint               # zero errors expected
```

Run tests from the repo root:

```bash
bun test examples/flyway-postgresql-gitlab-aws-rds/
```

## Deploy workflow

### Prerequisites

- AWS account with CloudFormation, EC2 (VPC), RDS, SSM permissions
- GitLab project with CI/CD enabled
- CI/CD variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION

### Steps

1. Create SSM parameter for RDS password: `./setup.sh`
2. Build: `bun run build`
3. Commit `templates/template.json`, `flyway.toml`, `.gitlab-ci.yml`, `sql/` to GitLab
4. Push — pipeline deploys CF stack, then runs Flyway migrations

### SSM password setup

```bash
./setup.sh                           # default: /myapp/dev/db-password
./setup.sh /myapp/prod/db-password   # custom path
```

## Verify

```bash
aws cloudformation describe-stacks --stack-name flyway-rds --query 'Stacks[0].StackStatus'
# Check pipeline in GitLab UI: CI/CD → Pipelines
```

## Teardown

```bash
aws cloudformation delete-stack --stack-name flyway-rds
aws cloudformation wait stack-delete-complete --stack-name flyway-rds
# Optionally delete SSM parameter:
aws ssm delete-parameter --name /myapp/dev/db-password
```

## Troubleshooting

- Pipeline deploy fails → check IAM permissions and CI/CD variables
- Migration fails with connection refused → check RDS security group allows GitLab runner IP
- SSM parameter not found → run `./setup.sh` first
- Flyway checksum mismatch → `flyway repair -environment=deploy`
