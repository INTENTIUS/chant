---
skill: chant-aws
description: Build, validate, and deploy CloudFormation templates from a chant project
user-invocable: true
---

# AWS CloudFormation Operational Playbook

## How chant and CloudFormation relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into CloudFormation JSON (or YAML). chant does NOT call AWS APIs. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local template comparison)
- Use **AWS CLI** for: validate-template, deploy, change sets, rollback, drift detection, and all stack operations

The source of truth for infrastructure is the TypeScript in `src/`. The generated template (`stack.json`) is an intermediate artifact.

## Build and validate

### Build the template

```bash
chant build src/ --output stack.json
```

Options:
- `--format yaml` — emit YAML instead of JSON
- `--watch` — rebuild on source changes

### Lint the source

```bash
chant lint src/
```

Options:
- `--fix` — auto-fix violations where possible
- `--format sarif` — SARIF output for CI integration
- `--watch` — re-lint on changes

### Validate with CloudFormation

```bash
aws cloudformation validate-template --template-body file://stack.json
```

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| `chant lint` | Best-practice violations, security anti-patterns, naming issues | Every edit |
| `chant build` | TypeScript errors, missing properties, type mismatches | Before deploy |
| `validate-template` | CloudFormation schema errors, invalid intrinsic usage | Before deploy |

Always run all three before deploying. Lint catches things validate-template cannot (and vice versa).

## Diffing and change preview

This is the most critical section for production safety. **Never deploy to production without previewing changes.**

### Local diff

Compare your proposed template against what is currently deployed:

```bash
# Get the currently deployed template
aws cloudformation get-template --stack-name <stack-name> --query TemplateBody --output json > deployed.json

# Build the proposed template
chant build src/ --output proposed.json

# Diff them
diff deployed.json proposed.json
```

### Change sets (recommended for production)

Change sets let you preview exactly what CloudFormation will do before it does it.

```bash
# 1. Create the change set
aws cloudformation create-change-set \
  --stack-name <stack-name> \
  --template-body file://stack.json \
  --change-set-name review-$(date +%s) \
  --capabilities CAPABILITY_NAMED_IAM

# 2. Wait for it to compute
aws cloudformation wait change-set-create-complete \
  --stack-name <stack-name> \
  --change-set-name review-<id>

# 3. Review the changes
aws cloudformation describe-change-set \
  --stack-name <stack-name> \
  --change-set-name review-<id>

# 4a. Execute if changes look safe
aws cloudformation execute-change-set \
  --stack-name <stack-name> \
  --change-set-name review-<id>

# 4b. Or delete if you want to abort
aws cloudformation delete-change-set \
  --stack-name <stack-name> \
  --change-set-name review-<id>
```

### Interpreting change set results

Each resource change has an **Action** and a **Replacement** value. Read them together:

| Action | Replacement | Risk | Meaning |
|--------|-------------|------|---------|
| Add | — | Low | New resource will be created |
| Modify | False | Low | In-place update, no disruption |
| Modify | Conditional | **MEDIUM** | May replace depending on property — investigate further |
| Modify | True | **HIGH** | Resource will be DESTROYED and recreated — **data loss risk** |
| Remove | — | **HIGH** | Resource will be deleted |

### Properties that always cause replacement

These property changes ALWAYS destroy and recreate the resource:
- `BucketName` on S3 buckets
- `TableName` on DynamoDB tables
- `DBInstanceIdentifier` on RDS instances
- `FunctionName` on Lambda functions
- `CidrBlock` on VPCs and subnets
- `ClusterIdentifier` on Redshift clusters
- `DomainName` on Elasticsearch/OpenSearch domains
- `TopicName` on SNS topics
- `QueueName` on SQS queues

**CRITICAL**: When you see `Replacement: True` on any stateful resource (databases, S3 buckets, queues with messages, DynamoDB tables), ALWAYS flag this to the user and get explicit confirmation before executing. This will destroy the existing resource and all its data.

## Deploying a new stack

```bash
aws cloudformation deploy \
  --template-file stack.json \
  --stack-name <stack-name> \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Env=prod Version=1.0 \
  --tags Project=myapp Environment=prod
```

### Capabilities

| Capability | When needed |
|------------|-------------|
| `CAPABILITY_IAM` | Template creates IAM resources with auto-generated names |
| `CAPABILITY_NAMED_IAM` | Template creates IAM resources with custom names (use this by default — it's a superset) |
| `CAPABILITY_AUTO_EXPAND` | Template uses macros or nested stacks with transforms |

**Recommendation**: Default to `CAPABILITY_NAMED_IAM` unless the template also uses macros, in which case use `--capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND`.

### Monitoring deployment

```bash
# Wait for completion (blocks until done)
aws cloudformation wait stack-create-complete --stack-name <stack-name>

# Or poll events in real-time
watch -n 5 "aws cloudformation describe-stack-events --stack-name <stack-name> --max-items 10 --query 'StackEvents[].{Time:Timestamp,Resource:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}' --output table"
```

### Getting outputs

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --query 'Stacks[0].Outputs'
```

## Updating an existing stack

### Safe path — change set workflow (production / stateful stacks)

1. Build: `chant build src/ --output stack.json`
2. Create change set (see Diffing section above)
3. Review every resource change — pay special attention to Replacement values
4. Get user confirmation for any destructive changes
5. Execute the change set
6. Monitor: `aws cloudformation wait stack-update-complete --stack-name <stack-name>`

### Fast path — direct deploy (dev / stateless stacks)

```bash
aws cloudformation deploy \
  --template-file stack.json \
  --stack-name <stack-name> \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

The `--no-fail-on-empty-changeset` flag prevents a non-zero exit code when there are no changes (useful in CI).

### Updating parameters only (no template change)

```bash
aws cloudformation deploy \
  --stack-name <stack-name> \
  --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Env=staging
```

### Which path to use

| Scenario | Path |
|----------|------|
| Production stack with databases/storage | Safe path (change set) |
| Any stack with `Replacement: True` changes | Safe path (change set) |
| Dev/test stack, stateless resources only | Fast path (direct deploy) |
| CI/CD automated pipeline with approval gate | Safe path (change set with manual approval) |
| Parameter-only change, no template diff | Fast path with `--use-previous-template` |

## Rollback and recovery

### Stack states reference

| State | Meaning | Action |
|-------|---------|--------|
| `CREATE_COMPLETE` | Stack created successfully | None — healthy |
| `UPDATE_COMPLETE` | Update succeeded | None — healthy |
| `DELETE_COMPLETE` | Stack deleted | Gone — recreate if needed |
| `CREATE_IN_PROGRESS` | Creation underway | Wait |
| `UPDATE_IN_PROGRESS` | Update underway | Wait |
| `DELETE_IN_PROGRESS` | Deletion underway | Wait |
| `ROLLBACK_IN_PROGRESS` | Create failed, rolling back | Wait |
| `UPDATE_ROLLBACK_IN_PROGRESS` | Update failed, rolling back | Wait |
| `CREATE_FAILED` | Creation failed (rare) | Check events, delete stack |
| `ROLLBACK_COMPLETE` | Create failed, rollback finished | **Must delete and recreate** — cannot update |
| `ROLLBACK_FAILED` | Create rollback failed | Check events, may need manual cleanup |
| `UPDATE_ROLLBACK_COMPLETE` | Update failed, rolled back to previous | Healthy — fix template and try again |
| `UPDATE_ROLLBACK_FAILED` | Update rollback itself failed | **See recovery steps below** |
| `DELETE_FAILED` | Deletion failed | Check events, retry or use retain |

### Recovering from UPDATE_ROLLBACK_FAILED

This is the most common "stuck" state. A resource that CloudFormation tried to roll back could not be restored.

**Step 1**: Identify the stuck resource:

```bash
aws cloudformation describe-stack-events \
  --stack-name <stack-name> \
  --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
  --output table
```

**Step 2a** — Try continuing the rollback:

```bash
aws cloudformation continue-update-rollback --stack-name <stack-name>
aws cloudformation wait stack-update-complete --stack-name <stack-name>
```

**Step 2b** — If that fails, skip the stuck resources:

```bash
aws cloudformation continue-update-rollback \
  --stack-name <stack-name> \
  --resources-to-skip LogicalResourceId1 LogicalResourceId2
```

**WARNING**: Skipping resources causes state divergence — CloudFormation's view of the stack will no longer match reality. You may need to manually clean up skipped resources or import them back later.

### Recovering from ROLLBACK_COMPLETE

A stack in `ROLLBACK_COMPLETE` cannot be updated. You must delete it and create a new one:

```bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
# Then deploy fresh
aws cloudformation deploy --template-file stack.json --stack-name <stack-name> --capabilities CAPABILITY_NAMED_IAM
```

## Stack lifecycle operations

### Delete a stack

```bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
```

If deletion fails because a resource cannot be deleted (e.g., non-empty S3 bucket), use retain:

```bash
aws cloudformation delete-stack \
  --stack-name <stack-name> \
  --retain-resources BucketLogicalId
```

To protect a stack from accidental deletion:

```bash
aws cloudformation update-termination-protection \
  --enable-termination-protection \
  --stack-name <stack-name>
```

### Drift detection

Detect whether resources have been modified outside of CloudFormation:

```bash
# Start detection
DRIFT_ID=$(aws cloudformation detect-stack-drift --stack-name <stack-name> --query StackDriftDetectionId --output text)

# Check status
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id $DRIFT_ID

# View drifted resources
aws cloudformation describe-stack-resource-drifts \
  --stack-name <stack-name> \
  --stack-resource-drift-status-filters MODIFIED DELETED
```

### Import existing resources

Bring resources that were created outside CloudFormation under stack management:

```bash
aws cloudformation create-change-set \
  --stack-name <stack-name> \
  --template-body file://stack.json \
  --change-set-name import-resources \
  --change-set-type IMPORT \
  --resources-to-import '[{"ResourceType":"AWS::S3::Bucket","LogicalResourceId":"MyBucket","ResourceIdentifier":{"BucketName":"existing-bucket-name"}}]'
```

## Troubleshooting decision tree

When a deployment fails, follow this diagnostic flow:

### Step 1: Check the stack status

```bash
aws cloudformation describe-stacks --stack-name <stack-name> --query 'Stacks[0].StackStatus' --output text
```

### Step 2: Branch on status

- **`*_IN_PROGRESS`** → Wait. Do not take action while an operation is in progress.
- **`*_FAILED` or `*_ROLLBACK_*`** → Read the events (Step 3).
- **`*_COMPLETE`** → Stack is stable. If behavior is wrong, check resource configuration.

### Step 3: Read the failure events

```bash
aws cloudformation describe-stack-events \
  --stack-name <stack-name> \
  --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId,ResourceStatusReason]" \
  --output table
```

### Step 4: Diagnose by error pattern

| Error pattern | Likely cause | Fix |
|---------------|-------------|-----|
| "already exists" | Resource name collision — another stack or manual creation owns this name | Use dynamic names: `Sub\`\${AWS.StackName}-myresource\`` |
| "not authorized" or "AccessDenied" | Missing IAM permissions, SCP restriction, or wrong `--capabilities` | Check IAM policy, add `--capabilities CAPABILITY_NAMED_IAM` |
| "limit exceeded" or "LimitExceededException" | AWS service quota hit | Request quota increase or reduce resource count |
| "Template error" or "Template format error" | Invalid template syntax | Run `aws cloudformation validate-template` and `chant lint src/` |
| "Circular dependency" | Two resources reference each other | Break the cycle — extract one reference to an output or parameter |
| "is in UPDATE_ROLLBACK_FAILED state and can not be updated" | Stuck rollback | See UPDATE_ROLLBACK_FAILED recovery above |
| "is in ROLLBACK_COMPLETE state and can not be updated" | Failed creation, rolled back | Delete the stack and recreate |
| "No updates are to be performed" | Template unchanged | Use `--no-fail-on-empty-changeset` or verify your changes are in the built template |
| "Resource is not in the state" | Resource was modified outside CF | Run drift detection, then update or import |
| "Maximum number of addresses has been reached" | EIP limit (default 5) | Request EIP quota increase |

## Quick reference

### Stack info commands

```bash
# List all stacks
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE

# Describe a stack (status, params, outputs, tags)
aws cloudformation describe-stacks --stack-name <stack-name>

# List resources in a stack
aws cloudformation list-stack-resources --stack-name <stack-name>

# Get outputs only
aws cloudformation describe-stacks --stack-name <stack-name> --query 'Stacks[0].Outputs'

# Recent events
aws cloudformation describe-stack-events --stack-name <stack-name> --max-items 20

# Get deployed template
aws cloudformation get-template --stack-name <stack-name> --query TemplateBody
```

### Full build-to-deploy pipeline

```bash
# 1. Lint
chant lint src/

# 2. Build
chant build src/ --output stack.json

# 3. Validate
aws cloudformation validate-template --template-body file://stack.json

# 4. Create change set
aws cloudformation create-change-set \
  --stack-name <stack-name> \
  --template-body file://stack.json \
  --change-set-name deploy-$(date +%s) \
  --capabilities CAPABILITY_NAMED_IAM

# 5. Review changes
aws cloudformation describe-change-set \
  --stack-name <stack-name> \
  --change-set-name deploy-<id>

# 6. Execute (after user confirms)
aws cloudformation execute-change-set \
  --stack-name <stack-name> \
  --change-set-name deploy-<id>

# 7. Wait for completion
aws cloudformation wait stack-update-complete --stack-name <stack-name>
```
