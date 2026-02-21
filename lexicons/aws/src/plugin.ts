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

  initTemplates(): Record<string, string> {
    return {
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
 */

import { Bucket, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { versioningEnabled, bucketEncryption, publicAccessBlock } from "./config";

export const logsBucket = new Bucket({
  BucketName: Sub\`\${AWS.StackName}-\${AWS.AccountId}-logs\`,
  AccessControl: "LogDeliveryWrite",
  VersioningConfiguration: versioningEnabled,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
});
`,
    };
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
    return [waw010, waw011, cor020, ext001, waw013, waw014, waw015];
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
        description: "AWS CloudFormation template management — workflows, patterns, and troubleshooting",
        content: `---
skill: chant-aws
description: Build, validate, and deploy CloudFormation templates from a chant project
user-invocable: true
---

# Deploying CloudFormation from Chant

This project defines CloudFormation resources as TypeScript in \`src/\`. Use these steps to build, validate, and deploy.

## Build the template

\`\`\`bash
chant build src/ --output stack.json
\`\`\`

## Validate before deploying

\`\`\`bash
chant lint src/
aws cloudformation validate-template --template-body file://stack.json
\`\`\`

## Deploy a new stack

\`\`\`bash
aws cloudformation deploy \\
  --template-file stack.json \\
  --stack-name <stack-name> \\
  --capabilities CAPABILITY_NAMED_IAM
\`\`\`

Add \`--parameter-overrides Key=Value\` if the template has parameters.

## Update an existing stack

1. Edit the TypeScript source
2. Rebuild: \`chant build src/ --output stack.json\`
3. Preview changes:
   \`\`\`bash
   aws cloudformation create-change-set \\
     --stack-name <stack-name> \\
     --template-body file://stack.json \\
     --change-set-name update-$(date +%s) \\
     --capabilities CAPABILITY_NAMED_IAM
   aws cloudformation describe-change-set \\
     --stack-name <stack-name> \\
     --change-set-name update-<id>
   \`\`\`
4. Execute: \`aws cloudformation execute-change-set --stack-name <stack-name> --change-set-name update-<id>\`

Or deploy directly: \`aws cloudformation deploy --template-file stack.json --stack-name <stack-name> --capabilities CAPABILITY_NAMED_IAM\`

## Delete a stack

\`\`\`bash
aws cloudformation delete-stack --stack-name <stack-name>
aws cloudformation wait stack-delete-complete --stack-name <stack-name>
\`\`\`

## Check stack status

\`\`\`bash
aws cloudformation describe-stacks --stack-name <stack-name>
aws cloudformation describe-stack-events --stack-name <stack-name> --max-items 10
\`\`\`

## Troubleshooting deploy failures

- Check events: \`aws cloudformation describe-stack-events --stack-name <stack-name>\`
- Rollback stuck: \`aws cloudformation continue-update-rollback --stack-name <stack-name>\`
- Drift: \`aws cloudformation detect-stack-drift --stack-name <stack-name>\`
`,
        triggers: [
          { type: "file-pattern", value: "**/*.aws.ts" },
          { type: "context", value: "aws" },
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
