---
skill: chant-aws
description: Build, validate, and deploy CloudFormation templates from a chant project
user-invocable: true
---

# Deploying CloudFormation from Chant

This project defines CloudFormation resources as TypeScript in `src/`. Use these steps to build, validate, and deploy.

## Build the template

```bash
chant build src/ --output stack.json
```

## Validate before deploying

```bash
chant lint src/
aws cloudformation validate-template --template-body file://stack.json
```

## Deploy a new stack

```bash
aws cloudformation deploy \
  --template-file stack.json \
  --stack-name <stack-name> \
  --capabilities CAPABILITY_NAMED_IAM
```

Add `--parameter-overrides Key=Value` if the template has parameters.

## Update an existing stack

1. Edit the TypeScript source
2. Rebuild: `chant build src/ --output stack.json`
3. Preview changes:
   ```bash
   aws cloudformation create-change-set \
     --stack-name <stack-name> \
     --template-body file://stack.json \
     --change-set-name update-$(date +%s) \
     --capabilities CAPABILITY_NAMED_IAM
   aws cloudformation describe-change-set \
     --stack-name <stack-name> \
     --change-set-name update-<id>
   ```
4. Execute: `aws cloudformation execute-change-set --stack-name <stack-name> --change-set-name update-<id>`

Or deploy directly: `aws cloudformation deploy --template-file stack.json --stack-name <stack-name> --capabilities CAPABILITY_NAMED_IAM`

## Delete a stack

```bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
```

## Check stack status

```bash
aws cloudformation describe-stacks --stack-name <stack-name>
aws cloudformation describe-stack-events --stack-name <stack-name> --max-items 10
```

## Troubleshooting deploy failures

- Check events: `aws cloudformation describe-stack-events --stack-name <stack-name>`
- Rollback stuck: `aws cloudformation continue-update-rollback --stack-name <stack-name>`
- Drift: `aws cloudformation detect-stack-drift --stack-name <stack-name>`
