# RDS PostgreSQL

A PostgreSQL RDS instance in private subnets, consuming a VPC — demonstrates composability between `VpcDefault` and `RdsPostgres` composites with SSM Parameter Store for secrets.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 20 CloudFormation resources:

**Network layer (17 resources via VpcDefault):**
- VPC, Internet Gateway, 2 public + 2 private subnets, NAT Gateway, route tables, and associations

**Database layer (3 resources via RdsPostgres):**
- **DB Subnet Group** — places the PostgreSQL instance in private subnets
- **Security Group** — allows inbound on port 5432 from the VPC CIDR
- **DB Instance** — PostgreSQL 16.4 on db.t4g.micro, encrypted at rest, 7-day backup retention

## Project Structure

```
src/
├── network.ts    # VpcDefault composite — foundational networking
├── database.ts   # RdsPostgres composite — consumes VPC outputs
├── params.ts     # CloudFormation Parameters (dbPasswordSsmPath, environment)
├── outputs.ts    # Stack Outputs (DB endpoint)
└── tags.ts       # defaultTags
```

## Patterns Demonstrated

1. **Composite composability** — `RdsPostgres` consumes `VpcDefault` outputs (`VpcId`, subnet IDs) as props
2. **SSM Parameter Store for secrets** — database password resolved from SSM at deploy time via `AWS::SSM::Parameter::Value<String>` parameter type
3. **Separation of concerns** — network and database layers are defined in separate files
4. **Secure defaults** — DB in private subnets, encrypted storage, automated backups

## Deploying

Use the chant-aws skill to build, validate, and deploy:
1. `chant build src/ --output stack.json`
2. `aws cloudformation validate-template --template-body file://stack.json`
3. `aws cloudformation deploy --template-file stack.json --stack-name my-rds --parameter-overrides dbPasswordSsmPath=/myapp/prod/db-password`

Before deploying, store your database password in SSM Parameter Store:
```bash
aws ssm put-parameter --name /myapp/prod/db-password --type SecureString --value "your-password"
```

The chant-aws skill (installed at `.claude/skills/chant-aws/SKILL.md`) provides full deployment guidance including change sets, rollback, and drift detection.
