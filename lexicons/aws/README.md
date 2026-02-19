# @intentius/chant-lexicon-aws

> Part of the [chant](../../README.md) monorepo. Published as [`@intentius/chant-lexicon-aws`](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) on npm.

AWS CloudFormation lexicon for chant — declare infrastructure as flat, typed TypeScript that serializes to CloudFormation JSON templates.

## Overview

This package provides:

- **CloudFormation serializer** — converts chant declarables to CloudFormation JSON templates
- **Intrinsic functions** — type-safe `Fn::Sub`, `Fn::GetAtt`, `Fn::Join`, etc.
- **Pseudo-parameters** — `AWS::Region`, `AWS::AccountId`, `AWS::StackName`, etc.
- **Resource types** — generated constructors for S3, Lambda, IAM, and all CloudFormation resource types
- **Lint rules** — AWS-specific validation (e.g. hardcoded region detection)
- **Code generation** — generates TypeScript types from CloudFormation resource specs
- **LSP/MCP support** — completions and hover for AWS resource types

## CloudFormation Concepts

### Templates

Chant builds a CloudFormation template from your declarations. Every exported resource becomes a logical resource in the `Resources` section. The serializer automatically:

- Wraps everything in `AWSTemplateFormatVersion: "2010-09-09"`
- Converts camelCase properties to PascalCase (CloudFormation convention)
- Resolves `AttrRef` references to `Fn::GetAtt`
- Resolves resource references to `Ref` intrinsics

```typescript
// This declaration...
export const dataBucket = new Bucket({
  bucketName: Sub`${AWS.StackName}-data`,
  versioningConfiguration: $.versioningEnabled,
});

// ...becomes this in the template:
// "DataBucket": {
//   "Type": "AWS::S3::Bucket",
//   "Properties": {
//     "BucketName": { "Fn::Sub": "${AWS::StackName}-data" },
//     "VersioningConfiguration": { "Status": "Enabled" }
//   }
// }
```

Build a template with:

```typescript
import { awsDomain } from "@intentius/chant-lexicon-aws";
import { build } from "@intentius/chant";

const result = await build("./src/infra", awsDomain);
```

### Parameters

CloudFormation parameters become template `Parameters` entries. Declare them using `CoreParameter`-implementing entities — the serializer detects them and places them in the `Parameters` section instead of `Resources`.

```typescript
// Parameters appear in the template as:
// "Parameters": {
//   "EnvName": { "Type": "String", "Default": "prod" }
// }
```

### Outputs

Use `output()` to create explicit stack outputs. The serializer collects them into the template's `Outputs` section. Cross-lexicon `AttrRef` usage is also auto-detected and promoted to outputs.

```typescript
import { output } from "@intentius/chant";

// Explicit output
const bucketArn = output(dataBucket.arn, "DataBucketArn");

// In the template:
// "Outputs": {
//   "DataBucketArn": {
//     "Value": { "Fn::GetAttr": ["DataBucket", "Arn"] }
//   }
// }
```

### Tagging

Tags are standard CloudFormation `Key`/`Value` arrays. Pass them as `tags` props on any resource that supports them:

```typescript
export const bucket = new Bucket({
  bucketName: "my-bucket",
  tags: [
    { key: "Environment", value: "production" },
    { key: "Team", value: "platform" },
  ],
});
```

To apply tags across all members of a composite, use `propagate`:

```typescript
import { propagate } from "@intentius/chant";

export const api = propagate(
  LambdaApi({ name: "myApi", code: lambdaCode }),
  { tags: [{ key: "env", value: "prod" }] },
);
// All expanded members (role, function, permission) will have these tags
```

See [Composites](#composites) for more on `propagate`.

## Intrinsic Functions

### Fn::Sub

```typescript
import { Sub, AWS } from "@intentius/chant-lexicon-aws";

const url = Sub`https://${bucket.domainName}/path`;
const arn = Sub`arn:aws:s3:::${AWS.Region}:${AWS.AccountId}:*`;
```

### Fn::GetAtt

```typescript
// Preferred: use AttrRef directly
const arnRef = myBucket.arn;

// Or explicit:
import { GetAtt } from "@intentius/chant-lexicon-aws";
const bucketArn = GetAtt("MyBucket", "Arn");
```

### Fn::Ref, Fn::Join, Fn::If, Fn::Select, Fn::Split, Fn::Base64

```typescript
import { Ref, Join, If, Select, Split, Base64 } from "@intentius/chant-lexicon-aws";

const paramRef = Ref("MyParameter");
const joined = Join("-", ["prefix", AWS.StackName, "suffix"]);
const value = If("UseProduction", "prod-value", "dev-value");
const firstItem = Select(0, Split(",", "a,b,c"));
const userData = Base64("#!/bin/bash\necho hello");
```

## Pseudo-Parameters

```typescript
import { AWS, Sub } from "@intentius/chant-lexicon-aws";

const endpoint = Sub`https://s3.${AWS.Region}.${AWS.URLSuffix}`;
```

| Pseudo-parameter | Description |
|---|---|
| `AWS.StackName` | Name of the stack |
| `AWS.Region` | AWS region where stack is created |
| `AWS.AccountId` | AWS account ID |
| `AWS.StackId` | Stack ID |
| `AWS.URLSuffix` | Domain suffix (usually `amazonaws.com`) |
| `AWS.Partition` | Partition (`aws`, `aws-cn`, `aws-us-gov`) |
| `AWS.NotificationARNs` | Notification ARNs |
| `AWS.NoValue` | Removes property when used with `Fn::If` |

## Examples

Two runnable examples live in `examples/`. Both have tests you can run with `bun test`.

### Getting Started (`examples/getting-started/`)

Declares 4 resources across separate files: two S3 buckets, an IAM role, and a Lambda function.

```
src/
├── _.ts              # Barrel — re-exports lexicon + auto-discovers sibling files
├── defaults.ts       # Shared config: encryption, versioning, public access block
├── data-bucket.ts    # S3 bucket using barrel defaults
├── logs-bucket.ts    # S3 bucket for access logs
├── role.ts           # IAM role with Lambda assume-role policy
└── handler.ts        # Lambda function referencing role and bucket
```

**Patterns demonstrated:**

1. **Flat declarations** — sub-resources like `encryptionDefault` and `publicAccessBlock` are their own named exports in `defaults.ts`, then referenced by other files via the barrel
2. **Barrel sharing** — `import * as _ from "./_"` gives every file access to all siblings via `_.$`
3. **Cross-resource references** — `$.dataBucket.arn` and `$.functionRole.arn` automatically serialize to `Fn::GetAtt`
4. **Intrinsics** — `Sub` with pseudo-parameters for dynamic naming: `Sub`\``${AWS.StackName}-data`\`

```typescript
// handler.ts — references role and bucket from other files
export const handler = new _.Function({
  functionName: _.Sub`${_.AWS.StackName}-handler`,
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: _.$.functionRole.arn,       // cross-file AttrRef
  code: lambdaCode,
  environment: { variables: { BUCKET_ARN: _.$.dataBucket.arn } },
});
```

### Advanced (`examples/advanced/`)

Builds on the getting-started patterns with composites, composite presets, custom lint rules, and IAM inline policies.

```
src/
├── _.ts              # Barrel — also re-exports Composite from core
├── chant.config.ts   # Lint config: strict preset + custom plugin
├── defaults.ts       # Encryption, versioning, access block, Lambda trust policy
├── data-bucket.ts    # S3 bucket
├── lambda-api.ts     # Composite factory + SecureApi/HighMemoryApi presets
├── health-api.ts     # Uses SecureApi preset — minimal health check
├── upload-api.ts     # Uses SecureApi + S3 PutObject policy
├── process-api.ts    # Uses HighMemoryApi + S3 read/write policy
└── lint/
    └── api-timeout.ts  # Custom WAW012 rule: Lambda API timeout check
```

**What it adds over getting-started:**

- **Composites** — `LambdaApi` groups a Role + Function + Permission into a reusable unit (see [Composites](#composites))
- **Composite presets** — `SecureApi` and `HighMemoryApi` wrap `LambdaApi` with sensible defaults for different workloads
- **Inline IAM policies** — `upload-api.ts` and `process-api.ts` attach `Role_Policy` objects to restrict S3 access per-API
- **Custom lint rules** — `api-timeout.ts` enforces API Gateway's 29-second timeout limit (see [Custom Lint Rules](#custom-lint-rules))
- **Lint configuration** — `chant.config.ts` extends the strict preset and loads the custom plugin

The advanced example produces 10 CloudFormation resources: 1 S3 bucket + 3 composites × 3 resources each (role, function, permission).

## Composites

Composites group related resources into reusable factories. A composite is a function that takes typed props and returns named members:

```typescript
import { Composite, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const LambdaApi = Composite<LambdaApiProps>((props) => {
  const role = new Role({
    assumeRolePolicyDocument: $.lambdaTrustPolicy,
    managedPolicyArns: [$.lambdaBasicExecutionArn],
    policies: props.policies,
  });

  const func = new Function({
    functionName: props.name,
    runtime: props.runtime,
    handler: props.handler,
    code: props.code,
    role: role.arn,          // cross-reference within the composite
    timeout: props.timeout,
    memorySize: props.memorySize,
  });

  const permission = new Permission({
    functionName: func.arn,
    action: "lambda:InvokeFunction",
    principal: "apigateway.amazonaws.com",
  });

  return { role, func, permission };
}, "LambdaApi");
```

Instantiate it like a function call:

```typescript
export const healthApi = LambdaApi({
  name: Sub`${AWS.StackName}-health`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: { zipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});
```

During build, composites expand to flat resources: `healthApi_role`, `healthApi_func`, `healthApi_permission`.

### `withDefaults` — composite presets

Wraps a composite with pre-applied defaults. Defaulted props become optional:

```typescript
import { withDefaults } from "@intentius/chant";

const SecureApi = withDefaults(LambdaApi, {
  runtime: "nodejs20.x",
  handler: "index.handler",
  timeout: 10,
  memorySize: 256,
});

// Only name and code are required now
export const healthApi = SecureApi({
  name: Sub`${AWS.StackName}-health`,
  code: { zipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});

// Composable — stack defaults on top of defaults
const HighMemoryApi = withDefaults(SecureApi, { memorySize: 2048, timeout: 25 });
```

`withDefaults` preserves the original composite's identity — it shares the same `_id` and `compositeName`, and does not create a new registry entry.

### `propagate` — shared properties

Attaches properties that merge into every member of a composite during expansion:

```typescript
import { propagate } from "@intentius/chant";

export const api = propagate(
  LambdaApi({ name: "myApi", code: lambdaCode }),
  { tags: [{ key: "env", value: "prod" }] },
);
// role, func, and permission all get the env tag
```

Merge semantics:
- **Scalars** — member-specific value wins over shared
- **Arrays** (e.g. tags) — shared values are prepended, then member values appended
- **`undefined`** — stripped from shared props, never overwrites

## Custom Lint Rules

Chant's lint engine runs TypeScript AST visitors. You can write project-specific rules that enforce domain conventions.

### Anatomy of a lint rule

A lint rule implements the `LintRule` interface:

```typescript
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
      // Walk the AST looking for violations...
      if (ts.isCallExpression(node)) {
        // Check call arguments, report diagnostics
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
```

The `check` function receives a `LintContext` containing the TypeScript `sourceFile` and returns an array of diagnostics with file, line, column, and message.

### Example: API Gateway timeout (`WAW012`)

The advanced example includes a custom rule that flags Lambda API composites with `timeout > 29` — API Gateway's synchronous limit:

```typescript
// lint/api-timeout.ts
const API_FACTORIES = new Set(["LambdaApi", "SecureApi", "HighMemoryApi"]);

export const apiTimeoutRule: LintRule = {
  id: "WAW012",
  severity: "error",
  category: "correctness",

  check(context: LintContext): LintDiagnostic[] {
    // Walks AST for calls to API factory functions,
    // checks timeout property value, reports if > 29
  },
};
```

### Registering custom rules

Add a `chant.config.ts` to your project root:

```typescript
// chant.config.ts
export default {
  lint: {
    extends: ["@intentius/chant/lint/presets/strict"],
    rules: {
      COR004: "off",                   // disable a built-in rule
    },
    plugins: ["./lint/api-timeout.ts"], // load custom rules
  },
};
```

The `plugins` array accepts relative paths. Each plugin module should export a `LintRule` object (named or as `apiTimeoutRule`, etc.).

### Built-in AWS lint rules

**`hardcoded-region`** — detects hardcoded AWS region strings:

```typescript
// Bad — hardcoded region
const endpoint = "s3.us-east-1.amazonaws.com";

// Good — use pseudo-parameter
const endpoint = Sub`s3.${AWS.Region}.amazonaws.com`;
```

## Code Generation

The AWS lexicon uses core's `generatePipeline` with AWS-specific callbacks:

- `codegen/generate.ts` — calls core `generatePipeline<SchemaParseResult>` with AWS callbacks
- `codegen/naming.ts` — extends core `NamingStrategy` with AWS data tables
- `codegen/package.ts` — calls core `packagePipeline` with AWS manifest and skill collector
- `spec/fetch.ts` — uses core `fetchWithCache` + `extractFromZip` for CloudFormation schema

## Template Import

Convert existing CloudFormation JSON/YAML to TypeScript:

```typescript
import { parseTemplate } from "@intentius/chant-lexicon-aws";

const ir = parseTemplate(cfTemplate);
// Generate TypeScript from the intermediate representation
```

## Related Packages

- `@intentius/chant` — core functionality, type system, and CLI
- `@intentius/chant-test-utils` — testing utilities

## License

See the main project LICENSE file.
