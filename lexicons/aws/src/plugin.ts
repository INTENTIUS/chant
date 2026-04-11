import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, ResourceMetadata } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { discoverLintRules, discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { awsSerializer } from "./serializer";
import { CFParser } from "./import/parser";
import { CFGenerator } from "./import/generator";
import { awsCompletions } from "./lsp/completions";
import { awsHover } from "./lsp/hover";

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
    const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "rules");
    return discoverLintRules(rulesDir, import.meta.url);
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

  initTemplates(template?: string) {
    if (template === "eks") {
      return { src: {
        "infra/cluster.ts": `/**
 * EKS Cluster + Managed Node Group + OIDC Provider
 */

import { Cluster, Nodegroup, OIDCProvider, Role, InstanceProfile, Sub, AWS } from "@intentius/chant-lexicon-aws";

// EKS Cluster Role
export const clusterRole = new Role({
  RoleName: Sub\`\${AWS.StackName}-eks-cluster-role\`,
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "eks.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  ],
});

// EKS Cluster
export const cluster = new Cluster({
  Name: Sub\`\${AWS.StackName}-cluster\`,
  RoleArn: clusterRole,
  Version: "1.29",
});

// Node Role
export const nodeRole = new Role({
  RoleName: Sub\`\${AWS.StackName}-eks-node-role\`,
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    }],
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ],
});

// Managed Node Group
export const nodeGroup = new Nodegroup({
  ClusterName: cluster,
  NodegroupName: Sub\`\${AWS.StackName}-nodes\`,
  NodeRole: nodeRole,
  ScalingConfig: {
    MinSize: 2,
    MaxSize: 10,
    DesiredSize: 3,
  },
  InstanceTypes: ["t3.medium"],
});
`,
        "k8s/namespace.ts": `/**
 * K8s namespace with quotas and network isolation
 */

import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

export const { namespace, resourceQuota, limitRange, networkPolicy } = NamespaceEnv({
  name: "prod",
  cpuQuota: "16",
  memoryQuota: "32Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "500m",
  defaultMemoryLimit: "512Mi",
  defaultDenyIngress: true,
});
`,
        "k8s/app.ts": `/**
 * Application deployment with IRSA and autoscaling
 */

import { AutoscaledService, IrsaServiceAccount } from "@intentius/chant-lexicon-k8s";

// IRSA ServiceAccount — replace with your IAM Role ARN from CloudFormation outputs
export const { serviceAccount } = IrsaServiceAccount({
  name: "app-sa",
  iamRoleArn: "arn:aws:iam::123456789012:role/app-role",  // TODO: update from CF output
  namespace: "prod",
});

export const { deployment, service, hpa, pdb } = AutoscaledService({
  name: "my-app",
  image: "my-app:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  namespace: "prod",
});
`,
      } };
    }

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
    return new CFParser();
  },

  templateGenerator(): TypeScriptGenerator {
    return new CFGenerator();
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
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

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-aws.md",
      name: "chant-aws",
      description: "AWS CloudFormation lifecycle — build, diff, deploy, rollback, and troubleshoot from a chant project",
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
    {
      file: "chant-aws-eks.md",
      name: "chant-aws-eks",
      description: "EKS end-to-end workflow — provision cluster, configure kubectl, deploy K8s workloads",
      triggers: [
        { type: "context", value: "eks" },
        { type: "context", value: "kubernetes" },
        { type: "context", value: "k8s-workloads" },
      ],
      parameters: [],
      examples: [
        {
          title: "Full EKS deployment",
          input: "Set up a complete EKS environment with my API",
          output: "chant build src/infra/ --output infra.json && aws cloudformation deploy --template-file infra.json --stack-name my-eks --capabilities CAPABILITY_NAMED_IAM",
        },
      ],
    },
  ]),

  completionProvider(ctx: CompletionContext): CompletionItem[] {
    return awsCompletions(ctx);
  },

  hoverProvider(ctx: HoverContext): HoverInfo | undefined {
    return awsHover(ctx);
  },

  async describeResources(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
  }): Promise<Record<string, ResourceMetadata>> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();
    const resources: Record<string, ResourceMetadata> = {};

    // Derive stack name: environment-based convention
    // Try to parse the build output to detect stack name from Metadata or use convention
    const stackName = `${options.environment}`;

    // Describe stack resources
    const listResult = await rt.spawn([
      "aws", "cloudformation", "describe-stack-resources",
      "--stack-name", stackName,
      "--output", "json",
    ]);

    if (listResult.exitCode !== 0) {
      throw new Error(`Failed to describe stack "${stackName}": ${listResult.stderr}`);
    }

    const data = JSON.parse(listResult.stdout) as {
      StackResources: Array<{
        LogicalResourceId: string;
        ResourceType: string;
        PhysicalResourceId: string;
        ResourceStatus: string;
        Timestamp: string;
      }>;
    };

    // Map logical names from build to stack resources
    const stackResourceMap = new Map<string, typeof data.StackResources[0]>();
    for (const r of data.StackResources) {
      stackResourceMap.set(r.LogicalResourceId, r);
    }

    // Get stack outputs
    const describeResult = await rt.spawn([
      "aws", "cloudformation", "describe-stacks",
      "--stack-name", stackName,
      "--output", "json",
    ]);

    let stackOutputs: Record<string, string> = {};
    if (describeResult.exitCode === 0) {
      const stacks = JSON.parse(describeResult.stdout) as {
        Stacks: Array<{ Outputs?: Array<{ OutputKey: string; OutputValue: string }> }>;
      };
      if (stacks.Stacks[0]?.Outputs) {
        for (const o of stacks.Stacks[0].Outputs) {
          stackOutputs[o.OutputKey] = o.OutputValue;
        }
      }
    }

    for (const entityName of options.entityNames) {
      const stackResource = stackResourceMap.get(entityName);
      if (!stackResource) continue;

      const attributes: Record<string, unknown> = {};
      // Include stack outputs as attributes (scrub sensitive ones)
      for (const [key, value] of Object.entries(stackOutputs)) {
        if (/password|secret|token|key/i.test(key)) {
          attributes[key] = "[REDACTED]";
        } else {
          attributes[key] = value;
        }
      }

      resources[entityName] = {
        type: stackResource.ResourceType,
        physicalId: stackResource.PhysicalResourceId,
        status: stackResource.ResourceStatus,
        lastUpdated: stackResource.Timestamp,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      };
    }

    return resources;
  },

  mcpTools() {
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for AWS CloudFormation",
        inputSchema: {
          type: "object" as const,
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

  mcpResources() {
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
