import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { awsSerializer } from "./serializer";

/**
 * AWS CloudFormation lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for AWS CloudFormation.
 */
export const awsPlugin: LexiconPlugin = {
  name: "aws",
  serializer: awsSerializer,

  lintRules(): LintRule[] {
    // Lazy-load to avoid pulling in rules unless needed
    const { hardcodedRegionRule } = require("./lint/rules/hardcoded-region");
    const { s3EncryptionRule } = require("./lint/rules/s3-encryption");
    const { iamWildcardRule } = require("./lint/rules/iam-wildcard");
    return [hardcodedRegionRule, s3EncryptionRule, iamWildcardRule];
  },

  intrinsics(): IntrinsicDef[] {
    return [
      { name: "Sub", description: "Fn::Sub template string interpolation" },
      { name: "Ref", description: "Reference a parameter or resource" },
      { name: "GetAtt", description: "Fn::GetAtt — get resource attribute" },
      { name: "If", description: "Fn::If — conditional value" },
      { name: "Join", description: "Fn::Join — join values with delimiter" },
      { name: "Select", description: "Fn::Select — select value by index" },
      { name: "Split", description: "Fn::Split — split string by delimiter" },
      { name: "Base64", description: "Fn::Base64 — encode to Base64" },
      { name: "GetAZs", description: "Fn::GetAZs — list Availability Zones" },
    ];
  },

  pseudoParameters(): string[] {
    return [
      "AWS::StackName",
      "AWS::Region",
      "AWS::AccountId",
      "AWS::StackId",
      "AWS::URLSuffix",
      "AWS::NoValue",
      "AWS::NotificationARNs",
      "AWS::Partition",
    ];
  },

  initTemplates() {
    return { src: {
      "config.ts": `/**
 * Shared bucket configuration — encryption, versioning, public access
 */

import { ServerSideEncryptionByDefault, ServerSideEncryptionRule, BucketEncryption, PublicAccessBlockConfiguration, VersioningConfiguration } from "@intentius/chant-lexicon-aws";

// Encryption default — AES256 server-side encryption
export const encryptionDefault = new ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});

// Encryption rule wrapping the default
export const encryptionRule = new ServerSideEncryptionRule({
  ServerSideEncryptionByDefault: encryptionDefault,
});

// Bucket encryption configuration
export const bucketEncryption = new BucketEncryption({
  ServerSideEncryptionConfiguration: [encryptionRule],
});

// Public access block — deny all public access
export const publicAccessBlock = new PublicAccessBlockConfiguration({
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
});

// Versioning — enabled
export const versioningEnabled = new VersioningConfiguration({
  Status: "Enabled",
});
`,
      "data-bucket.ts": `/**
 * Data bucket — primary storage with encryption and versioning
 */

import { Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./config";

export const dataBucket = new Bucket({
  BucketName: Sub\`\${AWS.StackName}-\${AWS.AccountId}-data\`,
  VersioningConfiguration: versioningEnabled,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
});
`,
      "logs-bucket.ts": `/**
 * Logs bucket — log delivery with encryption and versioning
 *
 * Note: AccessControl is a legacy property. Use a bucket policy to grant
 * log delivery access instead (s3:PutObject permission for the logging service principal).
 */

import { Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./config";

export const logsBucket = new Bucket({
  BucketName: Sub\`\${AWS.StackName}-\${AWS.AccountId}-logs\`,
  VersioningConfiguration: versioningEnabled,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
});
`,
    } };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // CloudFormation has AWSTemplateFormatVersion
    if (obj.AWSTemplateFormatVersion !== undefined) return true;

    // Or Resources with AWS::* types
    if (typeof obj.Resources === "object" && obj.Resources !== null) {
      for (const resource of Object.values(obj.Resources as Record<string, unknown>)) {
        if (typeof resource === "object" && resource !== null) {
          const type = (resource as Record<string, unknown>).Type;
          if (typeof type === "string" && type.startsWith("AWS::")) {
            return true;
          }
        }
      }
    }

    return false;
  },

  templateParser(): TemplateParser {
    const { CFParser } = require("./import/parser");
    return new CFParser();
  },

  templateGenerator(): TypeScriptGenerator {
    const { CFGenerator } = require("./import/generator");
    return new CFGenerator();
  },

  postSynthChecks(): PostSynthCheck[] {
    // Lazy-load to avoid pulling in checks unless needed
    const { waw010 } = require("./lint/post-synth/waw010");
    const { waw011 } = require("./lint/post-synth/waw011");
    const { cor020 } = require("./lint/post-synth/cor020");
    const { ext001 } = require("./lint/post-synth/ext001");
    const { waw013 } = require("./lint/post-synth/waw013");
    const { waw014 } = require("./lint/post-synth/waw014");
    const { waw015 } = require("./lint/post-synth/waw015");
    const { waw016 } = require("./lint/post-synth/waw016");
    const { waw017 } = require("./lint/post-synth/waw017");
    const { waw018 } = require("./lint/post-synth/waw018");
    const { waw019 } = require("./lint/post-synth/waw019");
    const { waw020 } = require("./lint/post-synth/waw020");
    const { waw021 } = require("./lint/post-synth/waw021");
    const { waw022 } = require("./lint/post-synth/waw022");
    const { waw023 } = require("./lint/post-synth/waw023");
    const { waw024 } = require("./lint/post-synth/waw024");
    const { waw025 } = require("./lint/post-synth/waw025");
    const { waw026 } = require("./lint/post-synth/waw026");
    const { waw027 } = require("./lint/post-synth/waw027");
    const { waw028 } = require("./lint/post-synth/waw028");
    const { waw029 } = require("./lint/post-synth/waw029");
    const { waw030 } = require("./lint/post-synth/waw030");
    return [
      waw010, waw011, cor020, ext001, waw013, waw014, waw015, waw016, waw017,
      waw018, waw019, waw020, waw021, waw022, waw023, waw024, waw025,
      waw026, waw027, waw028, waw029, waw030,
    ];
  },

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const result = await generate({ verbose: options?.verbose ?? true });
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeGeneratedFiles(result, pkgDir);

    console.error(`Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`);
    if (result.warnings.length > 0) {
      console.error(`${result.warnings.length} warnings`);
    }

    const { PINNED_VERSIONS } = await import("./codegen/versions");
    console.error(`cfn-lint patches: ${PINNED_VERSIONS.cfnLint}`);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { computeCoverage, checkThresholds, formatSummary, formatVerbose } = await import("./coverage");

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const report = computeCoverage(content);

    if (options?.verbose) {
      console.log(formatVerbose(report));
    } else {
      console.log(formatSummary(report));
    }

    if (typeof options?.minOverall === "number") {
      const result = checkThresholds(report, { minOverallPct: options.minOverall });
      if (!result.ok) {
        for (const v of result.violations) console.error(`  FAIL: ${v}`);
        throw new Error("Coverage below threshold");
      }
    }
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const distDir = join(pkgDir, "dist");
    writeBundleSpec(spec, distDir);

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);

    // Produce .tgz via pack command
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();
    const { stdout: packOut, stderr: packErr, exitCode: packExit } = await rt.spawn(
      rt.commands.packCmd,
      { cwd: pkgDir },
    );
    if (packExit === 0) {
      console.error(`Tarball: ${packOut.trim()}`);
    } else {
      console.error(`${rt.commands.packCmd.join(" ")} failed: ${packErr}`);
    }
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  skills(): SkillDefinition[] {
    return [
      {
        name: "chant-aws",
        description: "AWS CloudFormation lifecycle — build, diff, deploy, rollback, and troubleshoot from a chant project",
        content: `---
skill: chant-aws
description: Build, validate, and deploy CloudFormation templates from a chant project
user-invocable: true
---

# AWS CloudFormation Operational Playbook

## How chant and CloudFormation relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into CloudFormation JSON (or YAML). chant does NOT call AWS APIs. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local template comparison)
- Use **AWS CLI** for: validate-template, deploy, change sets, rollback, drift detection, and all stack operations

The source of truth for infrastructure is the TypeScript in \`src/\`. The generated template (\`stack.json\`) is an intermediate artifact.

## Build and validate

### Build the template

\`\`\`bash
chant build src/ --output stack.json
\`\`\`

Options:
- \`--format yaml\` — emit YAML instead of JSON
- \`--watch\` — rebuild on source changes

### Lint the source

\`\`\`bash
chant lint src/
\`\`\`

Options:
- \`--fix\` — auto-fix violations where possible
- \`--format sarif\` — SARIF output for CI integration
- \`--watch\` — re-lint on changes

### Validate with CloudFormation

\`\`\`bash
aws cloudformation validate-template --template-body file://stack.json
\`\`\`

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| \`chant lint\` | Best-practice violations, security anti-patterns, naming issues | Every edit |
| \`chant build\` | TypeScript errors, missing properties, type mismatches | Before deploy |
| \`validate-template\` | CloudFormation schema errors, invalid intrinsic usage | Before deploy |

Always run all three before deploying. Lint catches things validate-template cannot (and vice versa).

## Diffing and change preview

This is the most critical section for production safety. **Never deploy to production without previewing changes.**

### Local diff

Compare your proposed template against what is currently deployed:

\`\`\`bash
# Get the currently deployed template
aws cloudformation get-template --stack-name <stack-name> --query TemplateBody --output json > deployed.json

# Build the proposed template
chant build src/ --output proposed.json

# Diff them
diff deployed.json proposed.json
\`\`\`

### Change sets (recommended for production)

Change sets let you preview exactly what CloudFormation will do before it does it.

\`\`\`bash
# 1. Create the change set
aws cloudformation create-change-set \\
  --stack-name <stack-name> \\
  --template-body file://stack.json \\
  --change-set-name review-$(date +%s) \\
  --capabilities CAPABILITY_NAMED_IAM

# 2. Wait for it to compute
aws cloudformation wait change-set-create-complete \\
  --stack-name <stack-name> \\
  --change-set-name review-<id>

# 3. Review the changes
aws cloudformation describe-change-set \\
  --stack-name <stack-name> \\
  --change-set-name review-<id>

# 4a. Execute if changes look safe
aws cloudformation execute-change-set \\
  --stack-name <stack-name> \\
  --change-set-name review-<id>

# 4b. Or delete if you want to abort
aws cloudformation delete-change-set \\
  --stack-name <stack-name> \\
  --change-set-name review-<id>
\`\`\`

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
- \`BucketName\` on S3 buckets
- \`TableName\` on DynamoDB tables
- \`DBInstanceIdentifier\` on RDS instances
- \`FunctionName\` on Lambda functions
- \`CidrBlock\` on VPCs and subnets
- \`ClusterIdentifier\` on Redshift clusters
- \`DomainName\` on Elasticsearch/OpenSearch domains
- \`TopicName\` on SNS topics
- \`QueueName\` on SQS queues

**CRITICAL**: When you see \`Replacement: True\` on any stateful resource (databases, S3 buckets, queues with messages, DynamoDB tables), ALWAYS flag this to the user and get explicit confirmation before executing. This will destroy the existing resource and all its data.

## Deploying a new stack

\`\`\`bash
aws cloudformation deploy \\
  --template-file stack.json \\
  --stack-name <stack-name> \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --parameter-overrides Env=prod Version=1.0 \\
  --tags Project=myapp Environment=prod
\`\`\`

### Capabilities

| Capability | When needed |
|------------|-------------|
| \`CAPABILITY_IAM\` | Template creates IAM resources with auto-generated names |
| \`CAPABILITY_NAMED_IAM\` | Template creates IAM resources with custom names (use this by default — it's a superset) |
| \`CAPABILITY_AUTO_EXPAND\` | Template uses macros or nested stacks with transforms |

**Recommendation**: Default to \`CAPABILITY_NAMED_IAM\` unless the template also uses macros, in which case use \`--capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND\`.

### Monitoring deployment

\`\`\`bash
# Wait for completion (blocks until done)
aws cloudformation wait stack-create-complete --stack-name <stack-name>

# Or poll events in real-time
watch -n 5 "aws cloudformation describe-stack-events --stack-name <stack-name> --max-items 10 --query 'StackEvents[].{Time:Timestamp,Resource:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}' --output table"
\`\`\`

### Getting outputs

\`\`\`bash
aws cloudformation describe-stacks \\
  --stack-name <stack-name> \\
  --query 'Stacks[0].Outputs'
\`\`\`

## Updating an existing stack

### Safe path — change set workflow (production / stateful stacks)

1. Build: \`chant build src/ --output stack.json\`
2. Create change set (see Diffing section above)
3. Review every resource change — pay special attention to Replacement values
4. Get user confirmation for any destructive changes
5. Execute the change set
6. Monitor: \`aws cloudformation wait stack-update-complete --stack-name <stack-name>\`

### Fast path — direct deploy (dev / stateless stacks)

\`\`\`bash
aws cloudformation deploy \\
  --template-file stack.json \\
  --stack-name <stack-name> \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --no-fail-on-empty-changeset
\`\`\`

The \`--no-fail-on-empty-changeset\` flag prevents a non-zero exit code when there are no changes (useful in CI).

### Updating parameters only (no template change)

\`\`\`bash
aws cloudformation deploy \\
  --stack-name <stack-name> \\
  --use-previous-template \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --parameter-overrides Env=staging
\`\`\`

### Which path to use

| Scenario | Path |
|----------|------|
| Production stack with databases/storage | Safe path (change set) |
| Any stack with \`Replacement: True\` changes | Safe path (change set) |
| Dev/test stack, stateless resources only | Fast path (direct deploy) |
| CI/CD automated pipeline with approval gate | Safe path (change set with manual approval) |
| Parameter-only change, no template diff | Fast path with \`--use-previous-template\` |

## Rollback and recovery

### Stack states reference

| State | Meaning | Action |
|-------|---------|--------|
| \`CREATE_COMPLETE\` | Stack created successfully | None — healthy |
| \`UPDATE_COMPLETE\` | Update succeeded | None — healthy |
| \`DELETE_COMPLETE\` | Stack deleted | Gone — recreate if needed |
| \`CREATE_IN_PROGRESS\` | Creation underway | Wait |
| \`UPDATE_IN_PROGRESS\` | Update underway | Wait |
| \`DELETE_IN_PROGRESS\` | Deletion underway | Wait |
| \`ROLLBACK_IN_PROGRESS\` | Create failed, rolling back | Wait |
| \`UPDATE_ROLLBACK_IN_PROGRESS\` | Update failed, rolling back | Wait |
| \`CREATE_FAILED\` | Creation failed (rare) | Check events, delete stack |
| \`ROLLBACK_COMPLETE\` | Create failed, rollback finished | **Must delete and recreate** — cannot update |
| \`ROLLBACK_FAILED\` | Create rollback failed | Check events, may need manual cleanup |
| \`UPDATE_ROLLBACK_COMPLETE\` | Update failed, rolled back to previous | Healthy — fix template and try again |
| \`UPDATE_ROLLBACK_FAILED\` | Update rollback itself failed | **See recovery steps below** |
| \`DELETE_FAILED\` | Deletion failed | Check events, retry or use retain |

### Recovering from UPDATE_ROLLBACK_FAILED

This is the most common "stuck" state. A resource that CloudFormation tried to roll back could not be restored.

**Step 1**: Identify the stuck resource:

\`\`\`bash
aws cloudformation describe-stack-events \\
  --stack-name <stack-name> \\
  --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \\
  --output table
\`\`\`

**Step 2a** — Try continuing the rollback:

\`\`\`bash
aws cloudformation continue-update-rollback --stack-name <stack-name>
aws cloudformation wait stack-update-complete --stack-name <stack-name>
\`\`\`

**Step 2b** — If that fails, skip the stuck resources:

\`\`\`bash
aws cloudformation continue-update-rollback \\
  --stack-name <stack-name> \\
  --resources-to-skip LogicalResourceId1 LogicalResourceId2
\`\`\`

**WARNING**: Skipping resources causes state divergence — CloudFormation's view of the stack will no longer match reality. You may need to manually clean up skipped resources or import them back later.

### Recovering from ROLLBACK_COMPLETE

A stack in \`ROLLBACK_COMPLETE\` cannot be updated. You must delete it and create a new one:

\`\`\`bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
# Then deploy fresh
aws cloudformation deploy --template-file stack.json --stack-name <stack-name> --capabilities CAPABILITY_NAMED_IAM
\`\`\`

## Stack lifecycle operations

### Delete a stack

\`\`\`bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
\`\`\`

If deletion fails because a resource cannot be deleted (e.g., non-empty S3 bucket), use retain:

\`\`\`bash
aws cloudformation delete-stack \\
  --stack-name <stack-name> \\
  --retain-resources BucketLogicalId
\`\`\`

To protect a stack from accidental deletion:

\`\`\`bash
aws cloudformation update-termination-protection \\
  --enable-termination-protection \\
  --stack-name <stack-name>
\`\`\`

### Drift detection

Detect whether resources have been modified outside of CloudFormation:

\`\`\`bash
# Start detection
DRIFT_ID=$(aws cloudformation detect-stack-drift --stack-name <stack-name> --query StackDriftDetectionId --output text)

# Check status
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id $DRIFT_ID

# View drifted resources
aws cloudformation describe-stack-resource-drifts \\
  --stack-name <stack-name> \\
  --stack-resource-drift-status-filters MODIFIED DELETED
\`\`\`

### Import existing resources

Bring resources that were created outside CloudFormation under stack management:

\`\`\`bash
aws cloudformation create-change-set \\
  --stack-name <stack-name> \\
  --template-body file://stack.json \\
  --change-set-name import-resources \\
  --change-set-type IMPORT \\
  --resources-to-import '[{"ResourceType":"AWS::S3::Bucket","LogicalResourceId":"MyBucket","ResourceIdentifier":{"BucketName":"existing-bucket-name"}}]'
\`\`\`

## Troubleshooting decision tree

When a deployment fails, follow this diagnostic flow:

### Step 1: Check the stack status

\`\`\`bash
aws cloudformation describe-stacks --stack-name <stack-name> --query 'Stacks[0].StackStatus' --output text
\`\`\`

### Step 2: Branch on status

- **\`*_IN_PROGRESS\`** → Wait. Do not take action while an operation is in progress.
- **\`*_FAILED\` or \`*_ROLLBACK_*\`** → Read the events (Step 3).
- **\`*_COMPLETE\`** → Stack is stable. If behavior is wrong, check resource configuration.

### Step 3: Read the failure events

\`\`\`bash
aws cloudformation describe-stack-events \\
  --stack-name <stack-name> \\
  --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId,ResourceStatusReason]" \\
  --output table
\`\`\`

### Step 4: Diagnose by error pattern

| Error pattern | Likely cause | Fix |
|---------------|-------------|-----|
| "already exists" | Resource name collision — another stack or manual creation owns this name | Use dynamic names: \`Sub\\\`\\\${AWS.StackName}-myresource\\\`\` |
| "not authorized" or "AccessDenied" | Missing IAM permissions, SCP restriction, or wrong \`--capabilities\` | Check IAM policy, add \`--capabilities CAPABILITY_NAMED_IAM\` |
| "limit exceeded" or "LimitExceededException" | AWS service quota hit | Request quota increase or reduce resource count |
| "Template error" or "Template format error" | Invalid template syntax | Run \`aws cloudformation validate-template\` and \`chant lint src/\` |
| "Circular dependency" | Two resources reference each other | Break the cycle — extract one reference to an output or parameter |
| "is in UPDATE_ROLLBACK_FAILED state and can not be updated" | Stuck rollback | See UPDATE_ROLLBACK_FAILED recovery above |
| "is in ROLLBACK_COMPLETE state and can not be updated" | Failed creation, rolled back | Delete the stack and recreate |
| "No updates are to be performed" | Template unchanged | Use \`--no-fail-on-empty-changeset\` or verify your changes are in the built template |
| "Resource is not in the state" | Resource was modified outside CF | Run drift detection, then update or import |
| "Maximum number of addresses has been reached" | EIP limit (default 5) | Request EIP quota increase |

## Quick reference

### Stack info commands

\`\`\`bash
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
\`\`\`

### Full build-to-deploy pipeline

\`\`\`bash
# 1. Lint
chant lint src/

# 2. Build
chant build src/ --output stack.json

# 3. Validate
aws cloudformation validate-template --template-body file://stack.json

# 4. Create change set
aws cloudformation create-change-set \\
  --stack-name <stack-name> \\
  --template-body file://stack.json \\
  --change-set-name deploy-$(date +%s) \\
  --capabilities CAPABILITY_NAMED_IAM

# 5. Review changes
aws cloudformation describe-change-set \\
  --stack-name <stack-name> \\
  --change-set-name deploy-<id>

# 6. Execute (after user confirms)
aws cloudformation execute-change-set \\
  --stack-name <stack-name> \\
  --change-set-name deploy-<id>

# 7. Wait for completion
aws cloudformation wait stack-update-complete --stack-name <stack-name>
\`\`\`
`,
        triggers: [
          { type: "file-pattern", value: "**/*.aws.ts" },
          { type: "file-pattern", value: "**/stack.json" },
          { type: "file-pattern", value: "**/template.yaml" },
          { type: "context", value: "aws" },
          { type: "context", value: "cloudformation" },
          { type: "context", value: "deploy" },
        ],
        preConditions: [
          "AWS CLI is installed and configured (aws sts get-caller-identity succeeds)",
          "chant CLI is installed (chant --version succeeds)",
          "Project has chant source files in src/",
        ],
        postConditions: [
          "Stack is in a stable state (*_COMPLETE)",
          "No failed resources in stack events",
        ],
        parameters: [
          {
            name: "resourceType",
            description: "AWS CloudFormation resource type (e.g. AWS::S3::Bucket)",
            type: "string",
            required: false,
          },
        ],
        examples: [
          {
            title: "S3 Bucket with encryption",
            description: "Create an S3 bucket with server-side encryption enabled",
            input: "Create an encrypted S3 bucket",
            output: `new Bucket("MyBucket", {
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      { ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" } }
    ]
  },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
})`,
          },
          {
            title: "Deploy a new stack",
            description: "Build a chant project and deploy it as a new CloudFormation stack",
            input: "Deploy this project as a new stack called my-app-prod",
            output: `chant lint src/
chant build src/ --output stack.json
aws cloudformation validate-template --template-body file://stack.json
aws cloudformation deploy \\
  --template-file stack.json \\
  --stack-name my-app-prod \\
  --capabilities CAPABILITY_NAMED_IAM`,
          },
          {
            title: "Preview changes before updating",
            description: "Create a change set to review what will change before applying an update",
            input: "Show me what will change if I deploy this update to my-app-prod",
            output: `chant build src/ --output stack.json
aws cloudformation create-change-set \\
  --stack-name my-app-prod \\
  --template-body file://stack.json \\
  --change-set-name review-$(date +%s) \\
  --capabilities CAPABILITY_NAMED_IAM
# Wait for change set to compute, then review:
aws cloudformation describe-change-set \\
  --stack-name my-app-prod \\
  --change-set-name review-<id>`,
          },
          {
            title: "Fix a stuck rollback",
            description: "Recover a stack stuck in UPDATE_ROLLBACK_FAILED state",
            input: "My stack my-app-prod is stuck in UPDATE_ROLLBACK_FAILED, help me fix it",
            output: `# Identify the stuck resource
aws cloudformation describe-stack-events \\
  --stack-name my-app-prod \\
  --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \\
  --output table
# Attempt to continue the rollback
aws cloudformation continue-update-rollback --stack-name my-app-prod
aws cloudformation wait stack-update-complete --stack-name my-app-prod`,
          },
        ],
      },
    ];
  },

  completionProvider(ctx: CompletionContext): CompletionItem[] {
    const { awsCompletions } = require("./lsp/completions");
    return awsCompletions(ctx);
  },

  hoverProvider(ctx: HoverContext): HoverInfo | undefined {
    const { awsHover } = require("./lsp/hover");
    return awsHover(ctx);
  },

  mcpTools(): McpToolContribution[] {
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for AWS CloudFormation",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the infrastructure project directory",
            },
            output: {
              type: "string",
              description: "Path to the existing output file to compare against",
            },
          },
          required: ["path"],
        },
        async handler(params: Record<string, unknown>): Promise<unknown> {
          const { diffCommand } = await import("@intentius/chant/cli/commands/diff");
          const result = await diffCommand({
            path: (params.path as string) ?? ".",
            output: params.output as string | undefined,
            serializers: [awsSerializer],
          });
          return result;
        },
      },
    ];
  },

  mcpResources(): McpResourceContribution[] {
    return [
      {
        uri: "resource-catalog",
        name: "AWS Resource Catalog",
        description: "JSON list of all supported AWS CloudFormation resource types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-aws.json") as Record<string, { resourceType: string; kind: string }>;
          const resources = Object.entries(lexicon)
            .filter(([, entry]) => entry.kind === "resource")
            .map(([className, entry]) => ({
              className,
              resourceType: entry.resourceType,
            }));
          return JSON.stringify(resources);
        },
      },
      {
        uri: "examples/aws-s3-bucket",
        name: "AWS S3 Bucket Example",
        description: "AWS S3 bucket with versioning and encryption",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { ServerSideEncryptionByDefault, ServerSideEncryptionRule, BucketEncryption, VersioningConfiguration, Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";

// Encryption configuration
export const encryptionDefault = new ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});

export const encryptionRule = new ServerSideEncryptionRule({
  ServerSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new BucketEncryption({
  ServerSideEncryptionConfiguration: [encryptionRule],
});

// Versioning
export const versioningEnabled = new VersioningConfiguration({
  Status: "Enabled",
});

// Create a versioned bucket with encryption (AccountId ensures global uniqueness)
export const dataBucket = new Bucket({
  BucketName: Sub\`\${AWS.StackName}-\${AWS.AccountId}-data\`,
  VersioningConfiguration: versioningEnabled,
  BucketEncryption: bucketEncryption,
});
`;
        },
      },
      {
        uri: "examples/cross-references",
        name: "Cross References Example",
        description: "Using AttrRefs for cross-resource references",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Bucket, VersioningConfiguration, Role } from "@intentius/chant-lexicon-aws";

// Create a bucket
export const dataBucket = new Bucket({
  BucketName: "my-data-bucket",
  VersioningConfiguration: new VersioningConfiguration({ Status: "Enabled" }),
});

// Create a role that references the bucket's ARN
export const role = new Role({
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  },
});
`;
        },
      },
    ];
  },
};
