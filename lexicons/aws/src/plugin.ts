import type { LexiconPlugin, IntrinsicDef, SkillDefinition } from "@intentius/chant/lexicon";
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
      "_.ts": `export * from "./config";\n`,
      "config.ts": `/**
 * Shared bucket configuration — encryption, versioning, public access
 */

import * as aws from "@intentius/chant-lexicon-aws";

// Encryption default — AES256 server-side encryption
export const encryptionDefault = new aws.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

// Encryption rule wrapping the default
export const encryptionRule = new aws.ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

// Bucket encryption configuration
export const bucketEncryption = new aws.BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

// Public access block — deny all public access
export const publicAccessBlock = new aws.PublicAccessBlockConfiguration({
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

// Versioning — enabled
export const versioningEnabled = new aws.VersioningConfiguration({
  status: "Enabled",
});
`,
      "data-bucket.ts": `/**
 * Data bucket — primary storage with encryption and versioning
 */

import * as aws from "@intentius/chant-lexicon-aws";
import * as _ from "./_";

export const dataBucket = new aws.Bucket({
  bucketName: aws.Sub\`\${aws.AWS.StackName}-data\`,
  versioningConfiguration: _.versioningEnabled,
  bucketEncryption: _.bucketEncryption,
  publicAccessBlockConfiguration: _.publicAccessBlock,
});
`,
      "logs-bucket.ts": `/**
 * Logs bucket — log delivery with encryption and versioning
 */

import * as aws from "@intentius/chant-lexicon-aws";
import * as _ from "./_";

export const logsBucket = new aws.Bucket({
  bucketName: aws.Sub\`\${aws.AWS.StackName}-logs\`,
  accessControl: "LogDeliveryWrite",
  versioningConfiguration: _.versioningEnabled,
  bucketEncryption: _.bucketEncryption,
  publicAccessBlockConfiguration: _.publicAccessBlock,
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
    const result = await validate();

    for (const check of result.checks) {
      const status = check.ok ? "OK" : "FAIL";
      const msg = check.error ? ` — ${check.error}` : "";
      console.error(`  [${status}] ${check.name}${msg}`);
    }

    if (!result.success) {
      throw new Error("Validation failed");
    }
    console.error("All validation checks passed.");
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
    const { writeFileSync, mkdirSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    // Write manifest and artifacts to dist/
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const distDir = join(pkgDir, "dist");
    mkdirSync(join(distDir, "types"), { recursive: true });
    mkdirSync(join(distDir, "rules"), { recursive: true });
    mkdirSync(join(distDir, "skills"), { recursive: true });

    writeFileSync(join(distDir, "manifest.json"), JSON.stringify(spec.manifest, null, 2));
    writeFileSync(join(distDir, "meta.json"), spec.registry);
    writeFileSync(join(distDir, "types", "index.d.ts"), spec.typesDTS);

    for (const [name, content] of spec.rules) {
      writeFileSync(join(distDir, "rules", name), content);
    }
    for (const [name, content] of spec.skills) {
      writeFileSync(join(distDir, "skills", name), content);
    }

    // Write integrity.json if available
    if (spec.integrity) {
      writeFileSync(join(distDir, "integrity.json"), JSON.stringify(spec.integrity, null, 2));
    }

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);

    // Produce .tgz via bun pm pack
    const packProc = Bun.spawn(["bun", "pm", "pack"], {
      cwd: pkgDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const packOut = await new Response(packProc.stdout).text();
    const packErr = await new Response(packProc.stderr).text();
    const packExit = await packProc.exited;
    if (packExit === 0) {
      console.error(`Tarball: ${packOut.trim()}`);
    } else {
      console.error(`bun pm pack failed: ${packErr}`);
    }
  },

  async rollback(options?: { restore?: string; verbose?: boolean }): Promise<void> {
    const { listSnapshots, restoreSnapshot } = await import("./codegen/rollback");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const snapshotsDir = join(pkgDir, ".snapshots");

    if (options?.restore) {
      const generatedDir = join(pkgDir, "src", "generated");
      restoreSnapshot(String(options.restore), generatedDir);
      console.error(`Restored snapshot: ${options.restore}`);
    } else {
      const snapshots = listSnapshots(snapshotsDir);
      if (snapshots.length === 0) {
        console.error("No snapshots available.");
      } else {
        console.error(`Available snapshots (${snapshots.length}):`);
        for (const s of snapshots) {
          console.error(`  ${s.timestamp}  ${s.resourceCount} resources  ${s.path}`);
        }
      }
    }
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  skills(): SkillDefinition[] {
    return [
      {
        name: "aws-cloudformation",
        description: "AWS CloudFormation best practices and common patterns",
        content: `---
name: aws-cloudformation
description: AWS CloudFormation best practices and common patterns
---

# AWS CloudFormation with Chant

## Common Resource Types

- \`AWS::S3::Bucket\` — Object storage
- \`AWS::Lambda::Function\` — Serverless compute
- \`AWS::DynamoDB::Table\` — NoSQL database
- \`AWS::IAM::Role\` — Identity and access management
- \`AWS::SNS::Topic\` — Pub/sub messaging
- \`AWS::SQS::Queue\` — Message queue
- \`AWS::EC2::SecurityGroup\` — Network firewall rules

## Intrinsic Functions

- \`Sub\` — String interpolation with \`\${}\` syntax
- \`Ref\` — Reference a resource or parameter
- \`GetAtt\` — Get a resource attribute (e.g. ARN)
- \`If\` — Conditional value based on a condition
- \`Join\` — Join strings with a delimiter
- \`Select\` — Pick an item from a list by index

## Pseudo Parameters

- \`AWS::StackName\` — Name of the current stack
- \`AWS::Region\` — Current deployment region
- \`AWS::AccountId\` — Current AWS account ID
- \`AWS::Partition\` — Partition (aws, aws-cn, aws-us-gov)

## Best Practices

1. **Always enable encryption** — Use \`BucketEncryption\` for S3, \`SSESpecification\` for DynamoDB
2. **Block public access** — Set \`PublicAccessBlockConfiguration\` on all S3 buckets
3. **Use least-privilege IAM** — Avoid \`*\` in IAM policy actions and resources
4. **Enable versioning** — Turn on \`VersioningConfiguration\` for data buckets
5. **Use Sub for dynamic names** — \`Sub\\\`\\\${AWS::StackName}-suffix\\\`\` for unique naming
6. **Share config via barrel files** — Put common settings in \`_.ts\` and import as \`* as _\`
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
          return `import * as aws from "@intentius/chant-lexicon-aws";

// Encryption configuration
export const encryptionDefault = new aws.ServerSideEncryptionByDefault({
  sseAlgorithm: "AES256",
});

export const encryptionRule = new aws.ServerSideEncryptionRule({
  serverSideEncryptionByDefault: encryptionDefault,
});

export const bucketEncryption = new aws.BucketEncryption({
  serverSideEncryptionConfiguration: [encryptionRule],
});

// Versioning
export const versioningEnabled = new aws.VersioningConfiguration({
  status: "Enabled",
});

// Create a versioned bucket with encryption
export const dataBucket = new aws.Bucket({
  bucketName: aws.Sub\`\${aws.AWS.StackName}-data\`,
  versioningConfiguration: versioningEnabled,
  bucketEncryption: bucketEncryption,
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
          return `import * as aws from "@intentius/chant-lexicon-aws";

// Create a bucket
export const dataBucket = new aws.Bucket({
  bucketName: "my-data-bucket",
  versioningConfiguration: new aws.VersioningConfiguration({ status: "Enabled" }),
});

// Create a role that references the bucket's ARN
export const role = new aws.Role({
  assumeRolePolicyDocument: {
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
