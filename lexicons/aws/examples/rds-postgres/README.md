# RDS PostgreSQL

A PostgreSQL RDS instance in private subnets, consuming a VPC — demonstrates composability between `VpcDefault` and `RdsInstance` composites with SSM Parameter Store for secrets.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon aws`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the rds-postgres example to my AWS account.
> ```

## Quick Start

```bash
npm run build
```

## What It Does

The stack creates 20 CloudFormation resources:

**Network layer (17 resources via VpcDefault):**
- VPC, Internet Gateway, 2 public + 2 private subnets, NAT Gateway, route tables, and associations

**Database layer (3 resources via RdsInstance):**
- **DB Subnet Group** — places the PostgreSQL instance in private subnets
- **Security Group** — allows inbound on port 5432 from the VPC CIDR
- **DB Instance** — PostgreSQL 16.6 on db.t4g.micro, encrypted at rest, 7-day backup retention

## Project Structure

```
src/
├── network.ts    # VpcDefault composite — foundational networking
├── database.ts   # RdsInstance composite — consumes VPC outputs
├── params.ts     # CloudFormation Parameters (dbPasswordSsmPath, environment)
├── outputs.ts    # Stack Outputs (DB endpoint)
└── tags.ts       # defaultTags
```

## Patterns Demonstrated

1. **Composite composability** — `RdsInstance` consumes `VpcDefault` outputs (`VpcId`, subnet IDs) as props
2. **SSM Parameter Store for secrets** — database password resolved from SSM at deploy time via `AWS::SSM::Parameter::Value<String>` parameter type
3. **Separation of concerns** — network and database layers are defined in separate files
4. **Secure defaults** — DB in private subnets, encrypted storage, automated backups

## Deploying

**One-command deploy** (creates SSM parameter + builds + deploys):
```bash
npm run deploy
```

**Step by step:**
1. `npm run setup` — creates SSM SecureString at `/myapp/dev/db-password` with a random password
2. `npm run build` — generates CloudFormation template
3. `aws cloudformation deploy --template-file stack.json --stack-name rds-postgres-example`

To use a custom SSM path:
```bash
bash setup.sh /myapp/prod/db-password
aws cloudformation deploy --template-file stack.json --stack-name my-rds \
  --parameter-overrides dbPasswordSsmPath=/myapp/prod/db-password
```

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
