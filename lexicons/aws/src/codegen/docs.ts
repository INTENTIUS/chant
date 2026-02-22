/**
 * AWS CloudFormation documentation generator.
 *
 * Calls the core docsPipeline with AWS-specific config:
 * service grouping, resource type URLs, and overview content.
 *
 * Produces a standalone Starlight docs site at lexicons/aws/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname_, "..", "..");

/**
 * Extract the AWS service name from a CloudFormation resource type.
 * e.g. "AWS::S3::Bucket" → "S3", "AWS::Lambda::Function" → "Lambda"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Other";
}

const overview = `The **AWS CloudFormation** lexicon provides full support for defining AWS infrastructure using chant's declarative TypeScript syntax. Resources are serialized to CloudFormation JSON templates.

This lexicon is generated from the official [CloudFormation Resource Provider Schemas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-resource-specification.html) and includes coverage for all publicly available resource types.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-aws
\`\`\``;

const outputFormat = `The AWS lexicon serializes resources into **CloudFormation JSON templates**.

## Building

Run \`chant build\` to produce a CloudFormation template from your declarations:

\`\`\`bash
chant build
# Writes dist/template.json
\`\`\`

The generated template includes:

- \`AWSTemplateFormatVersion\` header
- \`Parameters\` section (if any parameters are declared)
- \`Resources\` section with typed resource definitions
- \`Outputs\` section for exported values
- Full support for intrinsic functions (\`Fn::Sub\`, \`Ref\`, \`Fn::GetAtt\`, etc.)

## Deploying

The output is standard CloudFormation JSON. Deploy with any CF-compatible tool:

\`\`\`bash
# AWS CLI
aws cloudformation deploy \\
  --template-file dist/template.json \\
  --stack-name my-stack \\
  --capabilities CAPABILITY_IAM

# Rain (faster, with diff preview)
rain deploy dist/template.json my-stack

# SAM CLI (if using serverless transforms)
sam deploy --template-file dist/template.json --stack-name my-stack
\`\`\`

## Compatibility

The output is compatible with:
- AWS CloudFormation service (direct deployment)
- AWS SAM CLI
- AWS CDK (as an escape hatch via \`CfnInclude\`)
- Rain and other CloudFormation tooling
- Any tool that accepts CloudFormation JSON templates`;

/**
 * Generate AWS lexicon documentation as a standalone Starlight site.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const log = options?.verbose
    ? (msg: string) => console.error(msg)
    : (_msg: string) => {};

  const distDir = join(pkgDir, "dist");
  const srcDir = join(pkgDir, "src");
  const outDir = join(pkgDir, "docs");

  const config: DocsConfig = {
    name: "aws",
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/aws/",
    displayName: "AWS CloudFormation",
    description: "AWS CloudFormation lexicon for chant — resource types, intrinsics, and lint rules",
    distDir,
    outDir,
    srcDir,
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["pseudo-parameters", "intrinsics", "rules"],
    examplesDir: join(pkgDir, "examples"),
    extraPages: [
      {
        slug: "cloudformation",
        title: "CloudFormation Concepts",
        description: "Templates, resources, parameters, outputs, dependencies, and tagging in the AWS CloudFormation lexicon",
        content: `Every exported resource declaration becomes a logical resource in a CloudFormation template. The serializer handles the translation automatically:

- Wraps output in \`AWSTemplateFormatVersion: "2010-09-09"\`
- Converts camelCase property names to PascalCase (CloudFormation convention)
- Resolves \`AttrRef\` references to \`Fn::GetAtt\`
- Resolves resource references to \`Ref\` intrinsics

{{file:lambda-s3/src/main.ts}}

The \`LambdaS3\` composite expands to 3 CloudFormation resources: an S3 Bucket, an IAM Role (with S3 read policy), and a Lambda Function. Property names like \`BucketName\` use the CloudFormation spec-native PascalCase directly, and the export name \`app\` becomes the resource name prefix (e.g. \`appBucket\`, \`appRole\`, \`appFunc\`).

## Resource types and naming

CloudFormation resource types like \`AWS::S3::Bucket\` are mapped to short TypeScript class names. The lexicon uses a naming strategy that prioritizes readability:

| CloudFormation Type | Chant Class | Rule |
|---|---|---|
| \`AWS::S3::Bucket\` | \`Bucket\` | Priority name (common resource) |
| \`AWS::Lambda::Function\` | \`Function\` | Priority name |
| \`AWS::IAM::Role\` | \`Role\` | Priority name |
| \`AWS::EC2::Instance\` | \`Instance\` | Short name (last segment) |
| \`AWS::EC2::SecurityGroup\` | \`SecurityGroup\` | Short name |
| \`AWS::ECS::Service\` | \`EcsService\` | Service-prefixed (avoids collision with \`AWS::AppRunner::Service\`) |

Common resources get fixed short names for stability. When two services define the same resource name (e.g. both ECS and AppRunner have \`Service\`), the less common one gets a service prefix.

**Discovering available resources:** Your editor's autocomplete is the best tool — every resource is a named export from the lexicon. You can also run \`chant list\` to see all resource types, or browse the generated TypeScript types.

## Imports and cross-file references

Chant projects use standard TypeScript imports. Lexicon types come from the lexicon package, and cross-file references are standard imports:

{{file:lambda-api/src/health-api.ts}}

When you reference a resource or attribute from another file (e.g. \`dataBucket.Arn\`), the serializer resolves it to \`Fn::GetAtt\` or \`Ref\` as appropriate. This is how cross-file references work — standard imports, no indirection.

## Parameters

CloudFormation parameters let you customize a stack at deploy time. Export a \`Parameter\` to add it to the template's \`Parameters\` section:

{{file:docs-snippets/src/parameter-ref.ts}}

Produces:

\`\`\`json
"Parameters": {
  "Name": {
    "Type": "String",
    "Description": "Project name used in resource naming"
  }
}
\`\`\`

Reference parameters with \`Ref\`:

{{file:docs-snippets/src/parameter-ref.ts}}

## Outputs

Use \`output()\` to create explicit stack outputs. Cross-resource \`AttrRef\` usage is also auto-detected and promoted to outputs when needed.

{{file:docs-snippets/src/output-explicit.ts}}

Produces:

\`\`\`json
"Outputs": {
  "DataBucketArn": {
    "Value": { "Fn::GetAtt": ["DataBucket", "Arn"] }
  }
}
\`\`\`

## Pseudo-parameters

Runtime context values available in every template, accessed via the \`AWS\` namespace:

{{file:docs-snippets/src/pseudo-params.ts}}

| Pseudo-parameter | Description |
|---|---|
| \`AWS.StackName\` | Name of the stack |
| \`AWS.Region\` | AWS region |
| \`AWS.AccountId\` | AWS account ID |
| \`AWS.StackId\` | Stack ID |
| \`AWS.URLSuffix\` | Domain suffix (usually \`amazonaws.com\`) |
| \`AWS.Partition\` | Partition (\`aws\`, \`aws-cn\`, \`aws-us-gov\`) |
| \`AWS.NotificationARNs\` | Notification ARNs |
| \`AWS.NoValue\` | Removes property when used with \`Fn::If\` |

## Intrinsic functions

The lexicon provides 8 intrinsic functions (\`Sub\`, \`Ref\`, \`GetAtt\`, \`If\`, \`Join\`, \`Select\`, \`Split\`, \`Base64\`) that map directly to CloudFormation \`Fn::\` calls. See [Intrinsic Functions](../intrinsics/) for full usage examples.

## Dependencies

CloudFormation automatically creates dependencies between resources when you use \`Ref\` or \`Fn::GetAtt\`. Chant leverages this — when you reference \`$.myBucket.arn\`, the serializer emits \`Fn::GetAtt\` and CloudFormation infers the dependency.

For cases where you need an explicit dependency without a property reference, pass \`DependsOn\` as a resource-level attribute (second constructor argument):

{{file:docs-snippets/src/depends-on.ts}}

\`DependsOn\` values can be string logical names or references to other resource objects — Declarable references are resolved to their logical names automatically at build time.

The \`WAW010\` post-synth check warns if a \`DependsOn\` target is already referenced via \`Ref\` or \`Fn::GetAtt\` in properties — in that case the explicit dependency is redundant.

## Resource attributes

Every resource constructor accepts an optional second argument for CloudFormation resource-level attributes. These control lifecycle behavior, conditional creation, and metadata — they are distinct from resource *properties* (the first argument).

{{file:docs-snippets/src/resource-attributes.ts}}

| Attribute | Type | Description |
|-----------|------|-------------|
| \`DependsOn\` | \`Declarable \\| Declarable[] \\| string \\| string[]\` | Explicit ordering dependency. Accepts resource references or logical name strings. |
| \`Condition\` | \`string\` | Only create this resource when the named Condition evaluates to true. |
| \`DeletionPolicy\` | \`"Delete" \\| "Retain" \\| "RetainExceptOnCreate" \\| "Snapshot"\` | What happens when the resource is removed from the template or the stack is deleted. |
| \`UpdateReplacePolicy\` | \`"Delete" \\| "Retain" \\| "Snapshot"\` | What happens to the old resource when CloudFormation replaces it during an update. |
| \`UpdatePolicy\` | \`object\` | Controls how Auto Scaling Groups perform rolling updates (\`AutoScalingRollingUpdate\`, \`AutoScalingReplacingUpdate\`). |
| \`CreationPolicy\` | \`object\` | Wait for resource signals before marking creation complete (\`ResourceSignal\` with \`Count\` and \`Timeout\`). |
| \`Metadata\` | \`Record<string, unknown>\` | Arbitrary metadata. Commonly used for \`AWS::CloudFormation::Init\` (cfn-init bootstrapping). Intrinsic functions in metadata values are resolved at build time. |

All attributes are optional. When omitted, CloudFormation uses its defaults (e.g. \`DeletionPolicy: "Delete"\`).

## Policy documents

IAM policy documents appear on many AWS resources — \`Role.assumeRolePolicyDocument\`, \`ManagedPolicy.policyDocument\`, \`BucketPolicy.policyDocument\`, and others. These properties are typed as \`PolicyDocument\`, giving you autocomplete for the IAM JSON Policy Language.

The \`PolicyDocument\` interface and its supporting types:

| Type | Fields |
|------|--------|
| \`PolicyDocument\` | \`Version?\` (\`"2012-10-17"\` \\| \`"2008-10-17"\`), \`Id?\`, \`Statement\` |
| \`IamPolicyStatement\` | \`Effect\` (\`"Allow"\` \\| \`"Deny"\`), \`Action?\`, \`Resource?\`, \`Principal?\`, \`Condition?\`, and their \`Not\` variants |
| \`IamPolicyPrincipal\` | \`"*"\` or \`{ AWS?, Service?, Federated? }\` |

Policy documents use **PascalCase keys** (\`Effect\`, \`Action\`, \`Resource\`) because they follow the IAM JSON Policy Language spec — CloudFormation passes them through to IAM as-is, unlike resource properties which are automatically converted from camelCase.

The recommended pattern is to extract policies into your \`defaults.ts\` and import them directly:

{{file:docs-snippets/src/policy-trust.ts}}

Then reference them from resource files:

{{file:docs-snippets/src/policy-role.ts}}

For scoped resource ARNs, use \`Sub\` in the policy constant:

{{file:docs-snippets/src/policy-scoped.ts}}

The \`IamPolicyPrincipal\` type supports all principal forms — wildcard (\`"*"\`), AWS accounts, services, and federated providers:

\`\`\`typescript
// Wildcard principal
Principal: "*",

// Service principal
Principal: { Service: "lambda.amazonaws.com" },

// Cross-account
Principal: { AWS: "arn:aws:iam::123456789012:root" },

// Multiple services
Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] },
\`\`\`

## Conditions

Use the \`If\` intrinsic for conditional values within resource properties:

{{file:docs-snippets/src/conditions.ts}}

CloudFormation \`Conditions\` blocks are recognized by the serializer when importing existing templates. For new stacks, use TypeScript logic for build-time decisions and \`If\` for deploy-time decisions.

## Mappings

CloudFormation Mappings are a static lookup mechanism. In chant, use TypeScript objects instead — they're evaluated at build time and produce the same result:

{{file:docs-snippets/src/mappings.ts}}

For deploy-time region lookups, combine \`AWS.Region\` with \`If\` or use \`Fn::Sub\` with SSM parameter store references.

## Nested stacks

:::caution
Nested stacks add deployment complexity and are not recommended for most projects. Prefer [flat composites](../composites/) instead.
:::

CloudFormation nested stacks (\`AWS::CloudFormation::Stack\`) split resources into child templates. The lexicon supports them via \`nestedStack()\` for cases where you exceed the 500-resource limit or need to package reusable infrastructure as a black box. See the [Nested Stacks](../nested-stacks/) page for details.

## Tagging

Use \`defaultTags()\` to declare project-wide tags. The serializer automatically injects them into every taggable resource at synthesis time:

{{file:docs-snippets/src/tagging.ts}}

No other changes needed — all taggable resources in the project get these tags automatically. Resources with explicit \`Tags\` keep them (explicit key wins over default). Non-taggable resources like \`AWS::Lambda::Permission\` are never tagged.

Tag values support strings, \`Parameter\` references, and intrinsic functions (\`Sub\`, \`Ref\`, etc.).`,
      },
      {
        slug: "intrinsics",
        title: "Intrinsic Functions",
        description: "CloudFormation intrinsic functions and their chant syntax",
        content: `CloudFormation intrinsic functions are available as imports from the lexicon. They produce the corresponding \`Fn::\` calls in the serialized template.

Here is a complete example using all intrinsic functions:

{{file:docs-snippets/src/intrinsics.ts}}

## \`Sub\` — string substitution

Tagged template literal that produces \`Fn::Sub\`. The most common intrinsic — use it for dynamic naming with pseudo-parameters and attribute references:

{{file:docs-snippets/src/intrinsics-detail.ts:3-5}}

\`Sub\` is a tagged template — use it with backticks, not as a function call.

## \`Ref\` — resource and parameter references

References a resource's physical ID or a parameter's value:

{{file:docs-snippets/src/intrinsics-detail.ts:7-9}}

In most cases you don't need \`Ref\` directly — the serializer automatically generates \`Ref\` when you reference an imported resource (e.g. \`dataBucket\` imported from another file).

## \`GetAtt\` — resource attributes

**Preferred:** Use AttrRef directly via the resource's typed properties. When you write \`dataBucket.arn\` (imported from the file that defines it), the serializer automatically emits \`Fn::GetAtt\`. Explicit \`GetAtt\` is only needed for dynamic or imported resource names.

## \`If\` — conditional values

Returns one of two values based on a condition:

{{file:docs-snippets/src/intrinsics-detail.ts:11-12}}

Use with \`AWS.NoValue\` to conditionally omit a property — see [Conditions](#conditions) on the CloudFormation Concepts page.

## \`Join\` — join values

Joins values with a delimiter:

{{file:docs-snippets/src/intrinsics-detail.ts:14-15}}

## \`Select\` — select by index

Selects a value from a list by index:

{{file:docs-snippets/src/intrinsics-detail.ts:17-18}}

## \`Split\` — split string

Splits a string by a delimiter:

{{file:docs-snippets/src/intrinsics-detail.ts:20-21}}

## \`Base64\` — encode to Base64

Encodes a string to Base64, commonly used for EC2 user data:

{{file:docs-snippets/src/intrinsics-detail.ts:23-27}}`,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "Composite resources, built-in composites, action constants, and withDefaults presets in the AWS CloudFormation lexicon",
        content: `Composites group related resources into reusable factories. See also the core [Composite Resources](/guide/composite-resources/) guide.

{{file:lambda-api/src/lambda-api.ts}}

Instantiate and export:

{{file:lambda-api/src/health-api.ts}}

During build, composites expand to flat CloudFormation resources: \`healthApiRole\`, \`healthApiFunc\`, \`healthApiPermission\`.

## Built-in composites

The AWS lexicon ships ready-to-use composites for common patterns. Import them from \`@intentius/chant-lexicon-aws\`:

{{file:docs-snippets/src/builtin-composites.ts}}

| Composite | Members | Description |
|-----------|---------|-------------|
| \`LambdaFunction\` | \`role\`, \`func\` | IAM Role + Lambda Function. Auto-attaches \`AWSLambdaBasicExecutionRole\`; adds \`AWSLambdaVPCAccessExecutionRole\` when \`VpcConfig\` is provided. |
| \`LambdaNode\` | \`role\`, \`func\` | \`LambdaFunction\` preset with \`Runtime: "nodejs20.x"\` and \`Handler: "index.handler"\` |
| \`LambdaPython\` | \`role\`, \`func\` | \`LambdaFunction\` preset with \`Runtime: "python3.12"\` and \`Handler: "handler.handler"\` |
| \`LambdaApi\` | \`role\`, \`func\`, \`permission\` | \`LambdaFunction\` + Lambda Permission for API Gateway invocation |
| \`LambdaScheduled\` | \`role\`, \`func\`, \`rule\`, \`permission\` | \`LambdaFunction\` + EventBridge Rule + Lambda Permission |
| \`LambdaSqs\` | \`queue\`, \`role\`, \`func\` | SQS Queue + Lambda + EventSourceMapping. Auto-attaches SQS receive policy. |
| \`LambdaEventBridge\` | \`rule\`, \`role\`, \`func\`, \`permission\` | EventBridge Rule + Lambda. Supports \`schedule\` and/or \`eventPattern\`. |
| \`LambdaDynamoDB\` | \`table\`, \`role\`, \`func\` | DynamoDB Table + Lambda. Auto-attaches DynamoDB policy and injects \`TABLE_NAME\` env var. |
| \`LambdaS3\` | \`bucket\`, \`role\`, \`func\` | S3 Bucket (encrypted, public access blocked) + Lambda. Auto-attaches S3 policy and injects \`BUCKET_NAME\` env var. |
| \`LambdaSns\` | \`topic\`, \`role\`, \`func\`, \`subscription\`, \`permission\` | SNS Topic + Lambda via Subscription. Auto-attaches invoke permission for SNS. |
| \`VpcDefault\` | \`vpc\`, \`igw\`, \`igwAttachment\`, \`publicSubnet1\`, \`publicSubnet2\`, \`privateSubnet1\`, \`privateSubnet2\`, \`publicRouteTable\`, \`publicRoute\`, \`publicRta1\`, \`publicRta2\`, \`privateRouteTable\`, \`privateRta1\`, \`privateRta2\`, \`natEip\`, \`natGateway\`, \`privateRoute\` | Production-ready VPC: 2 public + 2 private subnets across 2 AZs, internet gateway, single NAT gateway. |
| \`FargateAlb\` | \`cluster\`, \`executionRole\`, \`taskRole\`, \`logGroup\`, \`taskDef\`, \`albSg\`, \`taskSg\`, \`alb\`, \`targetGroup\`, \`listener\`, \`service\` | Fargate service behind an ALB. Accepts VPC outputs as props. |

All built-in composites accept \`ManagedPolicyArns\` and \`Policies\` for adding IAM permissions to the auto-created role.

## Action constants

Typed IAM action constants for common AWS services. Use them in policy documents instead of hand-typing action strings:

{{file:docs-snippets/src/action-constants.ts}}

Available constants:

| Constant | Key groups |
|----------|------------|
| \`S3Actions\` | \`ReadOnly\`, \`WriteOnly\`, \`ReadWrite\`, \`Full\`, \`GetObject\`, \`PutObject\`, \`DeleteObject\`, \`ListObjects\` |
| \`LambdaActions\` | \`Invoke\`, \`ReadOnly\`, \`Full\` |
| \`DynamoDBActions\` | \`ReadOnly\`, \`WriteOnly\`, \`ReadWrite\`, \`Full\`, \`GetItem\`, \`PutItem\`, \`Query\`, \`Scan\` |
| \`SQSActions\` | \`SendMessage\`, \`ReceiveMessage\`, \`Full\` |
| \`SNSActions\` | \`Publish\`, \`Subscribe\`, \`Full\` |
| \`IAMActions\` | \`PassRole\` |
| \`ECRActions\` | \`Pull\`, \`Full\` |
| \`LogsActions\` | \`Write\`, \`Full\` |
| \`ECSActions\` | \`RunTask\`, \`Service\`, \`Full\` |

Broad groups like \`ReadWrite\` are always supersets of their narrow counterparts (\`ReadOnly\` + \`WriteOnly\`). All values are \`as const\` arrays for full type safety.

## \`withDefaults\` — composite presets

Wrap a composite with pre-applied defaults. Defaulted props become optional:

{{file:docs-snippets/src/with-defaults.ts}}

\`withDefaults\` preserves the original composite's identity — same \`_id\` and \`compositeName\`, no new registry entry.

### Computed defaults

\`withDefaults\` also accepts a function that receives the caller's props and returns defaults. This enables conditional logic without generating extra resources:

{{file:docs-snippets/src/computed-defaults.ts}}

Merge order: computed defaults are applied first, then user-provided props override them.

## \`propagate\` — shared properties

Attach properties that merge into every member during expansion:

{{file:docs-snippets/src/propagate.ts}}

Merge semantics:
- **Scalars** — member-specific value wins over shared
- **Arrays** (e.g. tags) — shared values prepended, member values appended
- **\`undefined\`** — stripped from shared props, never overwrites

## Nested stacks

:::caution
Nested stacks add deployment complexity and are not recommended for most projects. Prefer flat composites instead.
:::

When you need to split resources into a separate CloudFormation template, the lexicon supports nested stacks via \`nestedStack()\`. See the [Nested Stacks](../nested-stacks/) page for details.`,
      },
      {
        slug: "nested-stacks",
        title: "Nested Stacks",
        sidebar: false,
        description: "Splitting resources into child CloudFormation templates with automatic cross-stack reference wiring",
        content: `CloudFormation nested stacks (\`AWS::CloudFormation::Stack\`) let you decompose large templates into smaller, reusable child templates. The AWS lexicon's \`nestedStack()\` function references a **child project directory** — a subdirectory that builds independently to a valid CloudFormation template.

:::caution[Consider alternatives first]
Nested stacks add deployment complexity: child templates must be uploaded to S3, rollbacks are all-or-nothing at the parent level, drift detection doesn't recurse into children, and debugging failures requires drilling into child stack events. For most projects, [flat composites](../composites/) are simpler. Nested stacks are supported for specific cases — exceeding CloudFormation's 500-resource limit or packaging reusable infrastructure as a black box — but are not the recommended default.
:::

## Project structure

A nested stack is a child project — a subdirectory with its own resource files and explicit \`stackOutput()\` declarations:

\`\`\`
src/
  app.ts                  # parent resources
  network/                # ← child project (nested stack)
    vpc.ts                # VPC, subnet, internet gateway, routing
    security.ts           # security group for Lambda
    outputs.ts            # declares cross-stack outputs
\`\`\`

## Declaring outputs in the child

Use \`stackOutput()\` to mark values that the parent can reference. Each \`stackOutput()\` becomes an entry in the child template's \`Outputs\` section:

{{file:../src/testdata/nested-stacks/network/outputs.ts}}

The child can be built independently:

\`\`\`bash
chant build src/network/ -o network.json
# Produces a standalone, valid CloudFormation template with Outputs
\`\`\`

## Referencing from the parent

Use \`nestedStack()\` in the parent to reference a child project directory. It returns an object with an \`outputs\` proxy for cross-stack references:

{{file:../src/testdata/nested-stacks/app.ts}}

\`network.outputs.subnetId\` produces a \`NestedStackOutputRef\` that serializes to \`{ "Fn::GetAtt": ["Network", "Outputs.SubnetId"] }\`.

## Build output

\`chant build\` produces multiple template files:

\`\`\`bash
chant build -o template.json
# Produces:
#   template.json              — parent template
#   network.template.json      — child template
\`\`\`

The parent template includes an \`AWS::CloudFormation::Stack\` resource pointing to the child:

\`\`\`json
"Network": {
  "Type": "AWS::CloudFormation::Stack",
  "Properties": {
    "TemplateURL": { "Fn::Sub": "\${TemplateBasePath}/network.template.json" }
  }
}
\`\`\`

## \`TemplateBasePath\` parameter

Every parent template gets a \`TemplateBasePath\` parameter (default \`"."\`) that controls where CloudFormation looks for child templates:

\`\`\`bash
# Local dev — default "." works with rain and similar tools
chant build -o template.json

# Production — override with S3 URL
aws cloudformation deploy \\
  --template-file template.json \\
  --stack-name my-stack \\
  --parameter-overrides TemplateBasePath=https://my-bucket.s3.amazonaws.com/templates
\`\`\`

Child templates also receive the \`TemplateBasePath\` parameter so it propagates through all nesting levels.

All child template files must be uploaded alongside the parent template (or to the S3 path specified by \`TemplateBasePath\`).

## Explicit parameters

Pass CloudFormation Parameters to child stacks with the \`parameters\` option:

\`\`\`typescript
import { nestedStack } from "@intentius/chant-lexicon-aws";

const network = nestedStack("network", import.meta.dirname + "/network", {
  parameters: { Environment: "prod", CidrBlock: "10.0.0.0/16" },
});
\`\`\`

## Recursive nesting

Child projects can themselves reference grandchild projects. Each level produces its own template file:

\`\`\`
src/
  app.ts
  infra/
    network/
      vpc.ts
      outputs.ts
    database/
      cluster.ts
      outputs.ts
\`\`\`

The build pipeline detects circular references and reports an error if child A references child B which references child A.

## Lint rules

Three lint rules help catch common nested stack issues:

| Rule | Severity | Description |
|------|----------|-------------|
| **WAW013** | error | Child project has no \`stackOutput()\` exports — parent can't reference anything |
| **WAW014** | warning | \`nestedStack()\` outputs never referenced from parent — could be a separate build |
| **WAW015** | error | Circular project references |

## When to use nested stacks

**Prefer flat composites** for most projects. Composites expand into a single template, deploy atomically, and are simpler to debug.

**Use nested stacks only when:**
- Your template exceeds CloudFormation's 500-resource limit
- You're packaging reusable infrastructure for other teams to deploy as a black box
- You need independent update/rollback boundaries (rare — this usually means the resources should be separate stacks entirely)

See [Composites](../composites/) for the flat composite approach.`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for AWS CloudFormation",
        content: `The AWS lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized CloudFormation output after \`chant build\`.

## Lint rules

Lint rules analyze your TypeScript source code before build.

### WAW001 — Hardcoded Region

**Severity:** warning | **Category:** security

Flags hardcoded AWS region strings like \`us-east-1\`. Use \`AWS.Region\` instead so templates are portable across regions.

**Bad** — triggers WAW001:

{{file:docs-snippets/src/lint-waw001-bad.ts}}

**Good** — uses \`AWS.Region\`:

{{file:docs-snippets/src/lint-waw001-good.ts}}

### WAW006 — S3 Bucket Encryption

**Severity:** warning | **Category:** security

Flags S3 buckets that don't configure server-side encryption. AWS recommends enabling encryption on all buckets.

**Bad** — triggers WAW006:

{{file:docs-snippets/src/lint-waw006-bad.ts}}

**Good** — encryption configured:

{{file:docs-snippets/src/lint-waw006-good.ts}}

### WAW009 — IAM Wildcard Resource

**Severity:** warning | **Category:** security

Flags IAM policy statements that use \`"Resource": "*"\`. Prefer scoped resource ARNs following the principle of least privilege.

**Bad** — triggers WAW009:

{{file:docs-snippets/src/lint-waw009-bad.ts}}

**Good** — scoped ARN:

{{file:docs-snippets/src/lint-waw009-good.ts}}

IAM policy documents use PascalCase keys (\`Effect\`, \`Action\`, \`Resource\`) matching the IAM JSON Policy Language spec. The \`PolicyDocument\` and \`IamPolicyStatement\` types provide full autocomplete for these fields.

## Post-synth checks

Post-synth checks run against the serialized CloudFormation JSON after build. They catch issues that are only visible in the final template.

### COR020 — Circular Resource Dependency

Detects cycles in the resource dependency graph built from \`Ref\`, \`Fn::GetAtt\`, and \`DependsOn\` entries. Circular dependencies cause CloudFormation deployments to fail.

### EXT001 — Extension Constraint Violation

Validates cross-property constraints from CloudFormation's cfn-lint extension schemas. For example, an EC2 instance might require \`SubnetId\` when \`NetworkInterfaces\` is not set.

### WAW010 — Redundant DependsOn

Flags \`DependsOn\` entries where the target resource is already referenced via \`Ref\` or \`Fn::GetAtt\` in the resource's properties. CloudFormation automatically creates dependencies for these references, making the explicit \`DependsOn\` unnecessary.

### WAW011 — Deprecated Lambda Runtime

Flags Lambda functions using deprecated or approaching-end-of-life runtimes (e.g. \`nodejs16.x\`, \`python3.8\`). Using deprecated runtimes prevents function updates and may cause deployment failures.

### WAW013 — No Stack Outputs

**Severity:** error | **Category:** correctness

Flags child projects (nested stacks) that have no \`stackOutput()\` exports. Without outputs, the parent stack can't reference any values from the child — either add \`stackOutput()\` declarations or remove the \`nestedStack()\` reference.

### WAW014 — Unreferenced Stack Outputs

**Severity:** warning | **Category:** style

Flags \`nestedStack()\` references whose outputs are never used from the parent. If no cross-stack references exist, the child project could just be built and deployed independently.

### WAW015 — Circular Project References

**Severity:** error | **Category:** correctness

Detects circular references between child projects (e.g. project A references project B which references project A). Circular project dependencies cause infinite build recursion.

### WAW016 — Deprecated Property Usage

**Severity:** warning | **Category:** correctness

Flags properties marked as deprecated in the CloudFormation Registry. Data comes from two sources: the explicit \`deprecatedProperties\` array in the Registry schema, and description text mining (keywords like "deprecated", "legacy", "no longer recommended").

For example, \`AccessControl\` on \`AWS::S3::Bucket\` is a legacy property — use a bucket policy to grant access instead.

\`\`\`
WAW016: Resource "MyBucket" (AWS::S3::Bucket) uses deprecated property "AccessControl" — consider alternatives
\`\`\`

### WAW017 — Missing Tags on Taggable Resource

**Severity:** info | **Category:** best practice

Flags resources that support tagging but have no \`Tags\` property set. Tags are important for cost allocation, compliance, and operational visibility. The check uses the \`tagging\` metadata from the CloudFormation Registry to determine which resources are taggable.

\`\`\`
WAW017: Resource "MyBucket" (AWS::S3::Bucket) supports tagging but has no Tags — consider adding tags for cost allocation and compliance
\`\`\`

### WAW029 — Invalid DependsOn Target

**Severity:** error | **Category:** correctness

Flags \`DependsOn\` entries that reference a non-existent resource (typo or deleted resource) or that create a self-reference. Both cases cause CloudFormation deployments to fail immediately.

\`\`\`
WAW029: Resource "MyService" has DependsOn "MyBukcet" which does not exist in the template
WAW029: Resource "MyBucket" has a DependsOn on itself — self-references are invalid
\`\`\`

### WAW030 — Missing DependsOn for Known Patterns

**Severity:** warning | **Category:** best practice

Flags resources that are likely missing a required explicit \`DependsOn\` based on well-known CloudFormation ordering requirements:

- **ECS Service + Listener**: An ECS Service with \`LoadBalancers\` should depend on the ALB Listener so the target group is fully configured before the service starts registering tasks.
- **EC2 Route + VPCGatewayAttachment**: A Route using a \`GatewayId\` should depend on the VPCGatewayAttachment so the gateway is attached to the VPC before the route is created.
- **API Gateway Deployment + Method**: A Deployment only references \`RestApiId\` — it needs an explicit \`DependsOn\` on its Methods or CloudFormation may create the deployment before any methods exist.
- **API Gateway V2 Deployment + Route**: Same as above for HTTP APIs — a V2 Deployment needs \`DependsOn\` on its Routes.
- **DynamoDB Table + ScalableTarget**: A ScalableTarget with \`ServiceNamespace: "dynamodb"\` references the table by string \`ResourceId\`, not \`Ref\` — it needs \`DependsOn\` so the table exists before scaling is registered.
- **ECS Service + ScalableTarget**: A ScalableTarget with \`ServiceNamespace: "ecs"\` references the service by string — it needs \`DependsOn\` so the ECS Service exists first.

\`\`\`
WAW030: ECS Service "MyService" has LoadBalancers but no DependsOn on a Listener
WAW030: Route "PublicRoute" uses a Gateway but has no dependency on VPCGatewayAttachment
WAW030: API Gateway Deployment "MyDeployment" has no DependsOn on any Method
WAW030: ScalableTarget "MyTarget" targets DynamoDB but has no DependsOn on any Table
\`\`\`

## Running lint

\`\`\`bash
# Lint your chant project
chant lint

# Lint with auto-fix where supported
chant lint --fix
\`\`\`

To suppress a rule on a specific line:

\`\`\`typescript
// chant-disable-next-line WAW001
const endpoint = "s3.us-east-1.amazonaws.com";
\`\`\`

To suppress globally in \`chant.config.ts\`:

\`\`\`typescript
export default {
  lint: {
    rules: {
      WAW001: "off",
    },
  },
};
\`\`\`

See also [Custom Lint Rules](../custom-rules/) for writing project-specific rules.`,
      },
      {
        slug: "custom-rules",
        title: "Custom Lint Rules",
        description: "Writing and registering project-specific lint rules for AWS CloudFormation",
        content: `Chant's lint engine runs TypeScript AST visitors. Write project-specific rules that enforce domain conventions.

## Anatomy of a lint rule

The lambda-api example includes a full custom rule implementation:

{{file:lambda-api/src/lint/api-timeout.ts}}

The \`check\` function receives a \`LintContext\` containing the TypeScript \`sourceFile\` and returns an array of diagnostics with file, line, column, and message.

## Registering custom rules

Add a \`chant.config.ts\` to your project:

{{file:lambda-api/src/chant.config.ts}}

The \`plugins\` array accepts relative paths. Each plugin module should export a \`LintRule\` object.`,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of the AWS CloudFormation lexicon examples",
        content: `Runnable examples live in the lexicon's \`examples/\` directory — one per built-in composite. Clone the repo and try them:

\`\`\`bash
cd examples/lambda-function
bun install
chant build    # produces CloudFormation JSON
chant lint     # runs lint rules
bun test       # runs the example's tests
\`\`\`

## Lambda Function

\`examples/lambda-function/\` — the simplest possible example. Uses \`LambdaNode\` to create a basic Lambda.

{{file:lambda-function/src/main.ts}}

Produces 2 CloudFormation resources: IAM Role + Lambda Function.

## Lambda S3

\`examples/lambda-s3/\` — Lambda that lists S3 objects using the \`LambdaS3\` composite.

{{file:lambda-s3/src/main.ts}}

Produces 3 resources: S3 Bucket (encrypted, public access blocked) + IAM Role (with S3 read policy) + Lambda Function. The \`BUCKET_NAME\` environment variable is auto-injected.

## Lambda DynamoDB

\`examples/lambda-dynamodb/\` — Lambda that reads/writes DynamoDB items using the \`LambdaDynamoDB\` composite.

{{file:lambda-dynamodb/src/main.ts}}

Produces 3 resources: DynamoDB Table + IAM Role (with DynamoDB read/write policy) + Lambda Function. The \`TABLE_NAME\` environment variable is auto-injected.

## Lambda SQS

\`examples/lambda-sqs/\` — Lambda processing messages from an SQS queue using the \`LambdaSqs\` composite.

{{file:lambda-sqs/src/main.ts}}

Produces 4 resources: SQS Queue + IAM Role (with SQS receive policy) + Lambda Function + EventSourceMapping.

## Lambda SNS

\`examples/lambda-sns/\` — Lambda triggered by SNS notifications using the \`LambdaSns\` composite.

{{file:lambda-sns/src/main.ts}}

Produces 5 resources: SNS Topic + IAM Role + Lambda Function + SNS Subscription + Lambda Permission.

## Lambda Scheduled

\`examples/lambda-scheduled/\` — Lambda on a cron schedule using the \`LambdaScheduled\` composite.

{{file:lambda-scheduled/src/main.ts}}

Produces 4 resources: IAM Role + Lambda Function + EventBridge Rule + Lambda Permission.

## Lambda EventBridge

\`examples/lambda-eventbridge/\` — Lambda triggered by EventBridge events using the \`LambdaEventBridge\` composite.

{{file:lambda-eventbridge/src/main.ts}}

Produces 4 resources: EventBridge Rule + IAM Role + Lambda Function + Lambda Permission.

## VPC

\`examples/vpc/\` — production-ready VPC using the \`VpcDefault\` composite.

{{file:vpc/src/main.ts}}

Produces 17 CloudFormation resources: VPC, Internet Gateway, 2 public + 2 private subnets, NAT Gateway with EIP, route tables, routes, and associations.

## Fargate ALB

\`examples/fargate-alb/\` — Fargate service behind an ALB, consuming a VPC. Demonstrates composite composability.

{{file:fargate-alb/src/network.ts}}

{{file:fargate-alb/src/service.ts}}

Produces 28 CloudFormation resources: 17 from VpcDefault + 11 from FargateAlb (ECS Cluster, execution/task roles, log group, task definition, security groups, ALB, target group, listener, and ECS service).

## Lambda API (Custom Composite)

\`examples/lambda-api/\` — demonstrates building your own composite factory with presets and a custom lint rule. This is the only example that teaches custom composite authoring.

\`\`\`
src/
├── chant.config.ts   # Lint config: strict preset + custom plugin
├── defaults.ts       # Encryption, versioning, access block, Lambda trust policy
├── data-bucket.ts    # S3 bucket
├── lambda-api.ts     # Composite factory + SecureApi/HighMemoryApi presets
├── health-api.ts     # SecureApi — minimal health check
├── upload-api.ts     # SecureApi + S3 PutObject policy
├── process-api.ts    # HighMemoryApi + S3 read/write policy
└── lint/
    └── api-timeout.ts  # Custom WAW012 rule
\`\`\`

**Patterns demonstrated:**

- **Custom composites** — \`LambdaApi\` groups Role + Function + Permission into a reusable unit (see [Composites](../composites/))
- **Composite presets** — \`SecureApi\` (low memory, short timeout) and \`HighMemoryApi\` (high memory, longer timeout)
- **Custom lint rule** — \`api-timeout.ts\` enforces API Gateway's 29-second timeout limit (see [Custom Lint Rules](../custom-rules/))

The example produces 10 CloudFormation resources: 1 S3 bucket + 3 composites × 3 members each.`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the AWS CloudFormation lexicon",
        content: `The AWS lexicon ships an AI skill called **chant-aws** that teaches AI coding agents (like Claude Code) how to build, validate, and deploy CloudFormation templates from a chant project.

## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically — giving it operational knowledge about the deployment workflow without requiring the user to explain each step.

## Installation

When you scaffold a new project with \`chant init --lexicon aws\`, the skill is installed to \`.claude/skills/chant-aws/SKILL.md\` for automatic discovery by Claude Code.

For existing projects, create the file manually:

\`\`\`
.claude/
  skills/
    chant-aws/
      SKILL.md    # skill content (see below)
\`\`\`

## Skill: chant-aws

The \`chant-aws\` skill covers the full deployment lifecycle:

- **Build** — \`chant build src/ --output stack.json\`
- **Validate** — \`chant lint src/\` + \`aws cloudformation validate-template\`
- **Deploy** — \`aws cloudformation deploy\` with capabilities
- **Update** — change sets for preview, or direct deploy
- **Delete** — \`aws cloudformation delete-stack\`
- **Status** — \`describe-stacks\` and \`describe-stack-events\`
- **Troubleshooting** — event inspection, rollback recovery, drift detection

The skill is invocable as a slash command: \`/chant-aws\`

## MCP integration

The lexicon also provides MCP (Model Context Protocol) tools and resources that AI agents can use programmatically:

| MCP tool | Description |
|----------|-------------|
| \`build\` | Build the chant project |
| \`lint\` | Run lint rules |
| \`explain\` | Summarize project resources |
| \`scaffold\` | Generate starter files |
| \`search\` | Search available resource types |
| \`aws:diff\` | Compare current build output against previous |

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported CloudFormation resource types |
| \`examples/basic-stack\` | Example stack with S3 bucket and IAM role |`,
      },
    ],
  };

  log("Generating AWS documentation...");
  const result = docsPipeline(config);

  log(`Writing standalone docs site to ${outDir}`);
  writeDocsSite(config, result);

  console.error(
    `Docs generated: ${result.stats.resources} resources, ${result.stats.services} services, ${result.stats.rules} rules`,
  );
}
