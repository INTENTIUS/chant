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

## Multi-file output (nested stacks)

When your project uses [nested stacks](./nested-stacks), \`chant build\` produces multiple template files:

\`\`\`bash
chant build -o template.json
# Produces:
#   template.json              — parent template
#   network.template.json      — child template (one per nestedStack)
\`\`\`

The parent template includes a \`TemplateBasePath\` parameter that controls where CloudFormation looks for child templates. Override it at deploy time to point to an S3 bucket:

\`\`\`bash
aws cloudformation deploy \\
  --template-file template.json \\
  --stack-name my-stack \\
  --parameter-overrides TemplateBasePath=https://my-bucket.s3.amazonaws.com/templates
\`\`\`

All child template files must be uploaded alongside the parent template (or to the S3 path specified by \`TemplateBasePath\`).

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

\`\`\`typescript
// This chant declaration...
export const dataBucket = new Bucket({
  bucketName: Sub\`\${AWS.StackName}-data\`,
  versioningConfiguration: $.versioningEnabled,
});
\`\`\`

Produces this CloudFormation resource:

\`\`\`json
"DataBucket": {
  "Type": "AWS::S3::Bucket",
  "Properties": {
    "BucketName": { "Fn::Sub": "\${AWS::StackName}-data" },
    "VersioningConfiguration": { "Status": "Enabled" }
  }
}
\`\`\`

Notice how \`dataBucket\` becomes \`DataBucket\` (PascalCase logical ID), and \`bucketName\` becomes \`BucketName\`. This mapping is automatic.

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

## The barrel file

Every chant project has a barrel file (conventionally \`_.ts\`) that re-exports the lexicon and provides cross-file references:

\`\`\`typescript
// _.ts — the barrel file
export * from "@intentius/chant-lexicon-aws";
import * as core from "@intentius/chant";
export const $ = core.barrel(import.meta.dir);
\`\`\`

Other files import the barrel and use \`$\` to reference sibling exports:

\`\`\`typescript
// data-bucket.ts
import * as _ from "./_";

export const dataBucket = new _.Bucket({
  bucketName: _.Sub\`\${_.AWS.StackName}-data\`,
  serverSideEncryptionConfiguration: _.$.encryptionDefault, // from defaults.ts
});
\`\`\`

The \`$\` proxy lazily resolves exports from other files in the same directory. When the serializer encounters \`_.$.encryptionDefault\`, it resolves to the actual exported value and serializes the reference as \`Fn::GetAtt\` or \`Ref\` as appropriate. This is how cross-file references work without circular imports.

## Parameters

CloudFormation parameters let you customize a stack at deploy time. Export a \`Parameter\` to add it to the template's \`Parameters\` section:

\`\`\`typescript
import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Deployment environment",
  defaultValue: "dev",
});
\`\`\`

Produces:

\`\`\`json
"Parameters": {
  "Environment": {
    "Type": "String",
    "Description": "Deployment environment",
    "Default": "dev"
  }
}
\`\`\`

Reference parameters with \`Ref\`:

\`\`\`typescript
import { Ref } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: Sub\`\${Ref("Environment")}-data\`,
});
\`\`\`

## Outputs

Use \`output()\` to create explicit stack outputs. Cross-resource \`AttrRef\` usage is also auto-detected and promoted to outputs when needed.

\`\`\`typescript
import { output } from "@intentius/chant";

export const bucketArn = output(dataBucket.arn, "DataBucketArn");
\`\`\`

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

\`\`\`typescript
import { AWS, Sub } from "@intentius/chant-lexicon-aws";

const endpoint = Sub\`https://s3.\${AWS.Region}.\${AWS.URLSuffix}\`;
\`\`\`

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

The lexicon provides 8 intrinsic functions (\`Sub\`, \`Ref\`, \`GetAtt\`, \`If\`, \`Join\`, \`Select\`, \`Split\`, \`Base64\`) that map directly to CloudFormation \`Fn::\` calls. See [Intrinsic Functions](./intrinsics) for full usage examples.

## Dependencies

CloudFormation automatically creates dependencies between resources when you use \`Ref\` or \`Fn::GetAtt\`. Chant leverages this — when you reference \`$.myBucket.arn\`, the serializer emits \`Fn::GetAtt\` and CloudFormation infers the dependency.

For cases where you need an explicit dependency without a property reference, set \`dependsOn\`:

\`\`\`typescript
export const appServer = new Instance({
  imageId: "ami-12345678",
  instanceType: "t3.micro",
  dependsOn: ["DatabaseCluster"],
});
\`\`\`

The \`WAW010\` post-synth check warns if a \`DependsOn\` target is already referenced via \`Ref\` or \`Fn::GetAtt\` in properties — in that case the explicit dependency is redundant.

## Policy documents

IAM policy documents appear on many AWS resources — \`Role.assumeRolePolicyDocument\`, \`ManagedPolicy.policyDocument\`, \`BucketPolicy.policyDocument\`, and others. These properties are typed as \`PolicyDocument\`, giving you autocomplete for the IAM JSON Policy Language.

The \`PolicyDocument\` interface and its supporting types:

| Type | Fields |
|------|--------|
| \`PolicyDocument\` | \`Version?\` (\`"2012-10-17"\` \\| \`"2008-10-17"\`), \`Id?\`, \`Statement\` |
| \`IamPolicyStatement\` | \`Effect\` (\`"Allow"\` \\| \`"Deny"\`), \`Action?\`, \`Resource?\`, \`Principal?\`, \`Condition?\`, and their \`Not\` variants |
| \`IamPolicyPrincipal\` | \`"*"\` or \`{ AWS?, Service?, Federated? }\` |

Policy documents use **PascalCase keys** (\`Effect\`, \`Action\`, \`Resource\`) because they follow the IAM JSON Policy Language spec — CloudFormation passes them through to IAM as-is, unlike resource properties which are automatically converted from camelCase.

The recommended pattern is to extract policies into your \`defaults.ts\` and reference them via the barrel:

\`\`\`typescript
// defaults.ts — shared trust policies and permission policies
import { Sub, AWS, type PolicyDocument } from "@intentius/chant-lexicon-aws";

export const lambdaTrustPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Service: "lambda.amazonaws.com" },
    Action: "sts:AssumeRole",
  }],
};

export const s3ReadPolicy: PolicyDocument = {
  Statement: [{
    Effect: "Allow",
    Action: ["s3:GetObject", "s3:ListBucket"],
    Resource: "*",
  }],
};
\`\`\`

Then reference them from resource files:

\`\`\`typescript
// role.ts
import * as _ from "./_";

export const functionRole = new _.Role({
  assumeRolePolicyDocument: _.$.lambdaTrustPolicy,
});

export const readPolicy = new _.ManagedPolicy({
  policyDocument: _.$.s3ReadPolicy,
  roles: [_.$.functionRole],
});
\`\`\`

For scoped resource ARNs, use \`Sub\` in the policy constant:

\`\`\`typescript
// defaults.ts
export const bucketWritePolicy: PolicyDocument = {
  Statement: [{
    Effect: "Allow",
    Action: ["s3:PutObject"],
    Resource: Sub\`arn:aws:s3:::\${AWS.StackName}-data/*\`,
  }],
};
\`\`\`

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

\`\`\`typescript
import { If } from "@intentius/chant-lexicon-aws";

export const bucket = new Bucket({
  bucketName: If("IsProduction", "prod-data", "dev-data"),
});
\`\`\`

CloudFormation \`Conditions\` blocks are recognized by the serializer when importing existing templates. For new stacks, use TypeScript logic for build-time decisions and \`If\` for deploy-time decisions.

## Mappings

CloudFormation Mappings are a static lookup mechanism. In chant, use TypeScript objects instead — they're evaluated at build time and produce the same result:

\`\`\`typescript
const regionAMIs: Record<string, string> = {
  "us-east-1": "ami-12345678",
  "us-west-2": "ami-87654321",
  "eu-west-1": "ami-abcdef01",
};

// Use directly in resource properties
export const server = new Instance({
  imageId: regionAMIs["us-east-1"],
  instanceType: "t3.micro",
});
\`\`\`

For deploy-time region lookups, combine \`AWS.Region\` with \`If\` or use \`Fn::Sub\` with SSM parameter store references.

## Nested stacks

CloudFormation nested stacks (\`AWS::CloudFormation::Stack\`) let you decompose large templates into smaller, reusable child templates. Use \`nestedStack()\` to reference a child project directory — a subdirectory with its own barrel file that builds independently:

\`\`\`typescript
// Child project declares outputs with stackOutput()
// src/network/outputs.ts
export const vpcId = stackOutput(_.$.vpc.vpcId);
export const subnetId = stackOutput(_.$.subnet.subnetId);
export const lambdaSgId = stackOutput(_.$.lambdaSg.groupId);

// Parent references the child project
// src/app.ts
const network = _.nestedStack("network", import.meta.dir + "/network");

export const handler = new _.Function({
  vpcConfig: {
    subnetIds: [network.outputs.subnetId],      // cross-stack ref
    securityGroupIds: [network.outputs.lambdaSgId],
  },
});
\`\`\`

chant handles the wiring: child template gets an \`Outputs\` section, parent uses \`Fn::GetAtt\` on the stack resource. A \`TemplateBasePath\` parameter lets you configure child template URLs per environment.

See [Nested Stacks](./nested-stacks) for the full guide.

## Tagging

Tags are standard CloudFormation \`Key\`/\`Value\` arrays. Pass them on any resource that supports tagging:

\`\`\`typescript
export const bucket = new Bucket({
  bucketName: "my-bucket",
  tags: [
    { key: "Environment", value: "production" },
    { key: "Team", value: "platform" },
  ],
});
\`\`\`

To apply tags across all members of a composite, use [\`propagate\`](./composites#propagate--shared-properties):

\`\`\`typescript
import { propagate } from "@intentius/chant";

export const api = propagate(
  LambdaApi({ name: "myApi", code: lambdaCode }),
  { tags: [{ key: "env", value: "prod" }] },
);
\`\`\``,
      },
      {
        slug: "intrinsics",
        title: "Intrinsic Functions",
        description: "CloudFormation intrinsic functions and their chant syntax",
        content: `CloudFormation intrinsic functions are available as imports from the lexicon. They produce the corresponding \`Fn::\` calls in the serialized template.

\`\`\`typescript
import { Sub, Ref, GetAtt, If, Join, Select, Split, Base64, AWS } from "@intentius/chant-lexicon-aws";
\`\`\`

## \`Sub\` — string substitution

Tagged template literal that produces \`Fn::Sub\`. The most common intrinsic — use it for dynamic naming with pseudo-parameters and attribute references:

\`\`\`typescript
// Simple pseudo-parameter substitution
const bucketName = Sub\`\${AWS.StackName}-data\`;
// → { "Fn::Sub": "\${AWS::StackName}-data" }

// Multiple pseudo-parameters
const arn = Sub\`arn:aws:s3:::\${AWS.AccountId}:\${AWS.Region}:*\`;

// With resource attribute references
const url = Sub\`https://\${bucket.domainName}/path\`;
// → { "Fn::Sub": "https://\${DataBucket.DomainName}/path" }
\`\`\`

\`Sub\` is a tagged template — use it with backticks, not as a function call.

## \`Ref\` — resource and parameter references

References a resource's physical ID or a parameter's value:

\`\`\`typescript
// Reference a parameter
const envRef = Ref("Environment");
// → { "Ref": "Environment" }

// Reference a resource (returns its physical ID)
const bucketRef = Ref("DataBucket");
// → { "Ref": "DataBucket" }
\`\`\`

In most cases you don't need \`Ref\` directly — the serializer automatically generates \`Ref\` when you reference a resource via the barrel (e.g. \`_.$.dataBucket\`).

## \`GetAtt\` — resource attributes

Retrieves an attribute from a resource:

\`\`\`typescript
// Explicit GetAtt
const bucketArn = GetAtt("DataBucket", "Arn");
// → { "Fn::GetAtt": ["DataBucket", "Arn"] }
\`\`\`

**Preferred:** Use AttrRef directly via the resource's typed properties. When you write \`$.dataBucket.arn\`, the serializer automatically emits \`Fn::GetAtt\`. Explicit \`GetAtt\` is only needed for dynamic or imported resource names.

## \`If\` — conditional values

Returns one of two values based on a condition:

\`\`\`typescript
const value = If("IsProduction", "prod-value", "dev-value");
// → { "Fn::If": ["IsProduction", "prod-value", "dev-value"] }
\`\`\`

Use with \`AWS.NoValue\` to conditionally omit a property:

\`\`\`typescript
export const bucket = new Bucket({
  bucketName: "my-bucket",
  accelerateConfiguration: If("EnableAcceleration",
    { accelerationStatus: "Enabled" },
    AWS.NoValue,
  ),
});
\`\`\`

## \`Join\` — join values

Joins values with a delimiter:

\`\`\`typescript
const joined = Join("-", ["prefix", AWS.StackName, "suffix"]);
// → { "Fn::Join": ["-", ["prefix", { "Ref": "AWS::StackName" }, "suffix"]] }
\`\`\`

## \`Select\` — select by index

Selects a value from a list by index:

\`\`\`typescript
const first = Select(0, Split(",", "a,b,c"));
// → { "Fn::Select": [0, { "Fn::Split": [",", "a,b,c"] }] }
\`\`\`

## \`Split\` — split string

Splits a string by a delimiter:

\`\`\`typescript
const parts = Split(",", "a,b,c");
// → { "Fn::Split": [",", "a,b,c"] }
\`\`\`

## \`Base64\` — encode to Base64

Encodes a string to Base64, commonly used for EC2 user data:

\`\`\`typescript
const userData = Base64(Sub\`#!/bin/bash
echo "Stack: \${AWS.StackName}"
yum update -y
\`);
// → { "Fn::Base64": { "Fn::Sub": "..." } }
\`\`\``,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "Composite resources, withDefaults presets, and propagate in the AWS CloudFormation lexicon",
        content: `Composites group related resources into reusable factories. See also the core [Composite Resources](/guide/composite-resources/) guide.

\`\`\`typescript
import * as _ from "./_";

export const LambdaApi = _.Composite<LambdaApiProps>((props) => {
  const role = new _.Role({
    assumeRolePolicyDocument: _.$.lambdaTrustPolicy,
    managedPolicyArns: [_.$.lambdaBasicExecutionArn],
    policies: props.policies,
  });

  const func = new _.Function({
    functionName: props.name,
    runtime: props.runtime,
    handler: props.handler,
    code: props.code,
    role: role.arn,
    timeout: props.timeout,
    memorySize: props.memorySize,
  });

  const permission = new _.Permission({
    functionName: func.arn,
    action: "lambda:InvokeFunction",
    principal: "apigateway.amazonaws.com",
  });

  return { role, func, permission };
}, "LambdaApi");
\`\`\`

Instantiate and export:

\`\`\`typescript
export const healthApi = LambdaApi({
  name: Sub\`\${AWS.StackName}-health\`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: { zipFile: \`exports.handler = async () => ({ statusCode: 200 });\` },
});
\`\`\`

During build, composites expand to flat CloudFormation resources: \`healthApi_role\` → \`HealthApiRole\`, \`healthApi_func\` → \`HealthApiFunc\`, \`healthApi_permission\` → \`HealthApiPermission\`.

## \`withDefaults\` — composite presets

Wrap a composite with pre-applied defaults. Defaulted props become optional:

\`\`\`typescript
import { withDefaults } from "@intentius/chant";

const SecureApi = withDefaults(LambdaApi, {
  runtime: "nodejs20.x",
  handler: "index.handler",
  timeout: 10,
  memorySize: 256,
});

// Only name and code are required now
export const healthApi = SecureApi({
  name: Sub\`\${AWS.StackName}-health\`,
  code: { zipFile: \`exports.handler = async () => ({ statusCode: 200 });\` },
});

// Composable — stack defaults on top of defaults
const HighMemoryApi = withDefaults(SecureApi, { memorySize: 2048, timeout: 25 });
\`\`\`

\`withDefaults\` preserves the original composite's identity — same \`_id\` and \`compositeName\`, no new registry entry.

## \`propagate\` — shared properties

Attach properties that merge into every member during expansion:

\`\`\`typescript
import { propagate } from "@intentius/chant";

export const api = propagate(
  LambdaApi({ name: "myApi", code: lambdaCode }),
  { tags: [{ key: "env", value: "prod" }] },
);
// role, func, and permission all receive the env tag
\`\`\`

Merge semantics:
- **Scalars** — member-specific value wins over shared
- **Arrays** (e.g. tags) — shared values prepended, member values appended
- **\`undefined\`** — stripped from shared props, never overwrites

## Nested stacks

When resources should produce a separate CloudFormation template instead of expanding into the parent, use a **child project** — a subdirectory with its own barrel file (\`_.ts\`) that builds independently. The parent references it with \`nestedStack()\`:

\`\`\`typescript
// src/app.ts — parent references child project directory
const network = _.nestedStack("network", import.meta.dir + "/network");

// Cross-stack reference via outputs proxy
export const handler = new _.Function({
  vpcConfig: { subnetIds: [network.outputs.subnetId] },
});
\`\`\`

See [Nested Stacks](./nested-stacks) for the full guide.`,
      },
      {
        slug: "nested-stacks",
        title: "Nested Stacks",
        description: "Splitting resources into child CloudFormation templates with automatic cross-stack reference wiring",
        content: `CloudFormation nested stacks (\`AWS::CloudFormation::Stack\`) let you decompose large templates into smaller, reusable child templates. The AWS lexicon's \`nestedStack()\` function references a **child project directory** — a subdirectory with its own barrel file that builds independently to a valid CloudFormation template.

## Project structure

A nested stack is a child project — a subdirectory with its own \`_.ts\` barrel, resource files, and explicit \`stackOutput()\` declarations:

\`\`\`
src/
  _.ts                    # parent barrel
  app.ts                  # parent resources
  network/                # ← child project (nested stack)
    _.ts                  # its own barrel
    vpc.ts                # VPC, subnet, internet gateway, routing
    security.ts           # security group for Lambda
    outputs.ts            # declares cross-stack outputs
\`\`\`

## Declaring outputs in the child

Use \`stackOutput()\` to mark values that the parent can reference. Each \`stackOutput()\` becomes an entry in the child template's \`Outputs\` section:

\`\`\`typescript
// src/network/outputs.ts
import * as _ from "./_";
import { stackOutput } from "@intentius/chant";

export const vpcId = stackOutput(_.$.vpc.vpcId, { description: "VPC ID" });
export const subnetId = stackOutput(_.$.subnet.subnetId, { description: "Public subnet ID" });
export const lambdaSgId = stackOutput(_.$.lambdaSg.groupId, { description: "Lambda security group ID" });
\`\`\`

The child can be built independently:

\`\`\`bash
chant build src/network/ -o network.json
# Produces a standalone, valid CloudFormation template with Outputs
\`\`\`

## Referencing from the parent

Use \`nestedStack()\` in the parent to reference a child project directory. It returns an object with an \`outputs\` proxy for cross-stack references:

\`\`\`typescript
// src/app.ts
import * as _ from "./_";

const network = _.nestedStack("network", import.meta.dir + "/network");

export const handler = new _.Function({
  functionName: _.Sub\`\${_.AWS.StackName}-handler\`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: _.Ref("LambdaExecutionRole"),
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  vpcConfig: {
    subnetIds: [network.outputs.subnetId],
    securityGroupIds: [network.outputs.lambdaSgId],
  },
});
\`\`\`

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

## Explicit parameters

Pass CloudFormation Parameters to child stacks with the \`parameters\` option:

\`\`\`typescript
const network = _.nestedStack("network", import.meta.dir + "/network", {
  parameters: { Environment: "prod", CidrBlock: "10.0.0.0/16" },
});
\`\`\`

## Recursive nesting

Child projects can themselves reference grandchild projects. Each level produces its own template file:

\`\`\`
src/
  _.ts
  app.ts
  infra/
    _.ts
    network/
      _.ts
      vpc.ts
      outputs.ts
    database/
      _.ts
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

**Use nested stacks when:**
- Your template exceeds CloudFormation's 500-resource limit
- You want to reuse a group of resources across multiple parent stacks
- You need independent update/rollback boundaries for parts of your infrastructure

**Use flat composites when:**
- Resources are tightly coupled and always deploy together
- You don't need independent update boundaries
- Your template is within resource limits

See [Composites](./composites) for the flat composite approach, and [Examples](./examples#nested-stacks) for a runnable nested stack example.`,
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

\`\`\`typescript
// Triggers WAW001
const endpoint = "s3.us-east-1.amazonaws.com";

// Fixed
const endpoint = Sub\`s3.\${AWS.Region}.amazonaws.com\`;
\`\`\`

### WAW006 — S3 Bucket Encryption

**Severity:** warning | **Category:** security

Flags S3 buckets that don't configure server-side encryption. AWS recommends enabling encryption on all buckets.

\`\`\`typescript
// Triggers WAW006
export const bucket = new Bucket({ bucketName: "my-bucket" });

// Fixed — add encryption configuration
export const bucket = new Bucket({
  bucketName: "my-bucket",
  bucketEncryption: {
    serverSideEncryptionConfiguration: [{
      serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
    }],
  },
});
\`\`\`

### WAW009 — IAM Wildcard Resource

**Severity:** warning | **Category:** security

Flags IAM policy statements that use \`"Resource": "*"\`. Prefer scoped resource ARNs following the principle of least privilege.

\`\`\`typescript
// Triggers WAW009
{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }

// Fixed — scope to a specific bucket
{ Effect: "Allow", Action: ["s3:GetObject"], Resource: Sub\`arn:aws:s3:::\${AWS.StackName}-data/*\` }
\`\`\`

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

See also [Custom Lint Rules](./custom-rules) for writing project-specific rules.`,
      },
      {
        slug: "custom-rules",
        title: "Custom Lint Rules",
        description: "Writing and registering project-specific lint rules for AWS CloudFormation",
        content: `Chant's lint engine runs TypeScript AST visitors. Write project-specific rules that enforce domain conventions.

## Anatomy of a lint rule

\`\`\`typescript
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const apiTimeoutRule: LintRule = {
  id: "WAW012",               // unique ID (WAW = AWS-specific prefix)
  severity: "error",           // "error" | "warning"
  category: "correctness",     // "correctness" | "style" | "security"

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Walk the AST looking for violations
      if (ts.isCallExpression(node)) {
        // Inspect arguments, report diagnostics
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
\`\`\`

## Example: API Gateway timeout (WAW012)

The advanced example includes a rule that flags Lambda API composites with \`timeout > 29\` — API Gateway's synchronous limit:

\`\`\`typescript
const API_FACTORIES = new Set(["LambdaApi", "SecureApi", "HighMemoryApi"]);

export const apiTimeoutRule: LintRule = {
  id: "WAW012",
  severity: "error",
  category: "correctness",

  check(context: LintContext): LintDiagnostic[] {
    // Walks AST for calls to API factory functions,
    // inspects the timeout property, reports if > 29
  },
};
\`\`\`

## Registering custom rules

Add a \`chant.config.ts\` to your project:

\`\`\`typescript
export default {
  lint: {
    extends: ["@intentius/chant/lint/presets/strict"],
    rules: {
      COR004: "off",                   // disable a built-in rule
    },
    plugins: ["./lint/api-timeout.ts"], // load custom rules
  },
};
\`\`\`

The \`plugins\` array accepts relative paths. Each plugin module should export a \`LintRule\` object.`,
      },
      {
        slug: "examples",
        title: "Examples",
        description: "Walkthrough of the getting-started and advanced AWS CloudFormation examples",
        content: `Two runnable examples live in the lexicon's \`examples/\` directory. Clone the repo and try them:

\`\`\`bash
cd examples/getting-started
bun install
chant build    # produces CloudFormation JSON
chant lint     # runs lint rules
bun test       # runs the example's tests
\`\`\`

## Getting Started

\`examples/getting-started/\` — 4 resources across separate files: two S3 buckets, an IAM role, and a Lambda function.

\`\`\`
src/
├── _.ts              # Barrel — re-exports lexicon + auto-discovers siblings
├── defaults.ts       # Shared config: encryption, versioning, public access block
├── data-bucket.ts    # S3 bucket using barrel defaults
├── logs-bucket.ts    # S3 bucket for access logs
├── role.ts           # IAM role with Lambda assume-role policy
└── handler.ts        # Lambda function referencing role and bucket
\`\`\`

**Patterns demonstrated:**

1. **Barrel file** — \`_.ts\` re-exports the AWS lexicon and creates the \`$\` proxy for cross-file references
2. **Shared defaults** — \`defaults.ts\` exports reusable property objects (\`encryptionDefault\`, \`publicAccessBlock\`) that other files reference via \`_.$\`
3. **Cross-resource references** — \`_.$.dataBucket.arn\` in \`handler.ts\` serializes to \`Fn::GetAtt\` in the template
4. **Intrinsics** — \`Sub\` tagged templates with pseudo-parameters for dynamic naming

\`\`\`typescript
// handler.ts — Lambda function referencing other resources
import * as _ from "./_";

const lambdaCode = { zipFile: "exports.handler = async () => ({ statusCode: 200 });" };

export const handler = new _.Function({
  functionName: _.Sub\`\${_.AWS.StackName}-handler\`,
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: _.$.functionRole.arn,          // → Fn::GetAtt
  code: lambdaCode,
  environment: {
    variables: { BUCKET_ARN: _.$.dataBucket.arn },  // → Fn::GetAtt
  },
});
\`\`\`

## Advanced

\`examples/advanced/\` — builds on getting-started with composites, presets, inline IAM policies, and a custom lint rule.

\`\`\`
src/
├── _.ts              # Barrel + re-exports Composite from core
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

**What it adds:**

- **Composites** — \`LambdaApi\` groups Role + Function + Permission into a reusable unit (see [Composites](./composites))
- **Composite presets** — \`SecureApi\` (low memory, short timeout) and \`HighMemoryApi\` (high memory, longer timeout) created with \`withDefaults\`
- **Inline IAM policies** — \`upload-api.ts\` and \`process-api.ts\` attach \`Role_Policy\` objects for scoped S3 access
- **Custom lint rule** — \`api-timeout.ts\` enforces API Gateway's 29-second timeout limit (see [Custom Lint Rules](./custom-rules))
- **Lint config** — \`chant.config.ts\` extends the strict preset and loads the custom plugin

The example produces 10 CloudFormation resources: 1 S3 bucket + 3 composites × 3 members each.

## Nested Stacks

\`examples/nested-stacks/\` — demonstrates child projects for splitting resources into child CloudFormation templates with automatic cross-stack reference wiring.

\`\`\`
src/
├── _.ts              # Parent barrel
├── app.ts            # Lambda function (references network outputs)
└── network/          # Child project (nested stack)
    ├── _.ts          # Child barrel
    ├── vpc.ts        # VPC, subnet, internet gateway, route table
    ├── security.ts   # Security group for Lambda
    └── outputs.ts    # stackOutput() declarations
\`\`\`

**Patterns demonstrated:**

1. **Child project** — \`network/\` is a separate project directory with its own barrel, resources, and \`stackOutput()\` exports
2. **Cross-stack references** — \`app.ts\` accesses \`network.outputs.subnetId\` and \`network.outputs.lambdaSgId\`, which serialize to \`Fn::GetAtt\` on the parent's \`AWS::CloudFormation::Stack\` resource
3. **Multi-file output** — build produces \`template.json\` (parent) and \`network.template.json\` (child)
4. **TemplateBasePath** — auto-generated parameter for configuring child template URLs per environment

\`\`\`typescript
// network/outputs.ts — child declares what the parent can reference
import * as _ from "./_";
import { stackOutput } from "@intentius/chant";

export const vpcId = stackOutput(_.$.vpc.vpcId, { description: "VPC ID" });
export const subnetId = stackOutput(_.$.subnet.subnetId, { description: "Public subnet ID" });
export const lambdaSgId = stackOutput(_.$.lambdaSg.groupId, { description: "Lambda security group ID" });
\`\`\`

\`\`\`typescript
// app.ts — parent references child project
import * as _ from "./_";

const network = _.nestedStack("network", import.meta.dir + "/network");

export const handler = new _.Function({
  functionName: _.Sub\`\${_.AWS.StackName}-handler\`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: _.Ref("LambdaExecutionRole"),
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  vpcConfig: {
    subnetIds: [network.outputs.subnetId],
    securityGroupIds: [network.outputs.lambdaSgId],
  },
});
\`\`\`

See [Nested Stacks](./nested-stacks) for the full guide.`,
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
