import { createRequire } from "module";
import { detectTemplate } from "./detect";
import type { LexiconPlugin, IntrinsicDef, ObservationResult, DeepObservationResult, ResourceMetadata, ExportedTemplate, ResourceSelector, InitTemplateSet, StackStatusObservation } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { discoverLintRules } from "@intentius/chant/lint/discover";
import { postSynthChecks as postSynthCheckList } from "./lint/post-synth";
import { awsAuditCatalog } from "./lint/audit-catalog";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { awsSerializer } from "./serializer";
import { FLOCI_EMULATOR } from "./op/activities/floci";
import { applyAwsEndpointArgv } from "./components/cloud-executor";
import { stackDoesNotExist } from "./stack-errors";
import { awsDeepNormalizationHooks, observeResourcesDeepAws } from "./deep-observe";
import { awsReferenceCatalog } from "./reference-catalog";
import { resolveTemplateAttrs } from "./live-attrs";
import { CFParser } from "./import/parser";
import { CFGenerator } from "./import/generator";
import { parseStackTemplate } from "./import/live-export";
import { awsCompletions } from "./lsp/completions";
import { awsHover } from "./lsp/hover";

/** Re-exported from ./stack-errors so the long-standing import path (and its
 * tests) keep working now that the deep reader shares the classifier. */
export { stackDoesNotExist } from "./stack-errors";

/**
 * AWS CloudFormation lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for AWS CloudFormation.
 */
export const awsPlugin: LexiconPlugin = {
  name: "aws",
  serializer: awsSerializer,
  // Local emulator (#920): Floci + the AWS env that redirects the SDK / observe.
  emulator: FLOCI_EMULATOR,
  // Audit rule metadata for this lexicon's WAW* checks (#687).
  auditCatalog: () => awsAuditCatalog,
  // Live edge reconstruction for `chant graph --live` (#778).
  referenceCatalog: awsReferenceCatalog,

  lintRules(): LintRule[] {
    const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "rules");
    return discoverLintRules(rulesDir, import.meta.url);
  },

  /**
   * chant #1044 — every plain-call intrinsic below carries
   * `foldsAsCall: true`, opting its CALL form into `chant build --fold`.
   *
   * Audited one at a time against the criterion in `IntrinsicDef.foldsAsCall`
   * (core's lexicon.ts): the call must be a pure function of its arguments
   * that builds a deterministic data envelope. Each of these constructs its
   * `*Intrinsic` class and stores the arguments verbatim (../intrinsics.ts) —
   * no I/O, no environment, no module state, and no CloudFormation semantics
   * evaluated locally: `Base64("x")` emits `{"Fn::Base64": "x"}` for the
   * deployment to encode, it does not encode anything here. Calling one while
   * folding is therefore indistinguishable from calling it during a real run
   * of the file.
   *
   * `Sub` is the one intrinsic NOT opted in, and cannot be: it is authored as
   * a tagged template (`isTag: true`), which already folds through
   * `foldTaggedTemplate`. `Sub(...)` as a plain call is not its authoring
   * form, and `chant dev check-lexicon` rejects a registration claiming both.
   */
  intrinsics(): IntrinsicDef[] {
    return [
      { name: "Sub", description: "Fn::Sub template string interpolation", isTag: true },
      { name: "Ref", description: "Reference a parameter or resource", isTag: false, foldsAsCall: true },
      { name: "GetAtt", description: "Fn::GetAtt — get resource attribute", isTag: false, foldsAsCall: true },
      { name: "If", description: "Fn::If — conditional value", isTag: false, foldsAsCall: true },
      { name: "Join", description: "Fn::Join — join values with delimiter", isTag: false, foldsAsCall: true },
      { name: "Select", description: "Fn::Select — select value by index", isTag: false, foldsAsCall: true },
      { name: "Split", description: "Fn::Split — split string by delimiter", isTag: false, foldsAsCall: true },
      { name: "Base64", description: "Fn::Base64 — encode to Base64", isTag: false, foldsAsCall: true },
      { name: "GetAZs", description: "Fn::GetAZs — list Availability Zones", isTag: false, foldsAsCall: true },
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

  initTemplates(template?: string): InitTemplateSet {
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

  detectTemplate,

  templateParser(): TemplateParser {
    return new CFParser();
  },

  templateGenerator(): TypeScriptGenerator {
    return new CFGenerator();
  },

  postSynthChecks() {
    return postSynthCheckList;
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
    {
      file: "chant-aws-carve-terraform.md",
      name: "chant-aws-carve-terraform",
      description: "Demo carving a resource out of Terraform into native chant — advise, emit, bridge, apply — fully offline",
      triggers: [
        { type: "context", value: "terraform" },
        { type: "context", value: "carve" },
        { type: "context", value: "migrate" },
        { type: "file-pattern", value: "**/*.tf" },
        { type: "file-pattern", value: "**/terraform.tfstate" },
      ],
      preConditions: [
        "chant CLI is installed (chant --version succeeds)",
        "@cdktf/hcl2json is installed (npm install -D @cdktf/hcl2json)",
      ],
      parameters: [
        {
          name: "address",
          description: "Terraform address to carve, e.g. aws_s3_bucket.assets",
          type: "string",
          required: false,
        },
      ],
      examples: [
        {
          title: "Run the offline demo",
          description: "Demo the full advise → emit → bridge → apply loop with no cloud",
          input: "Show me how chant carves a resource out of Terraform",
          output: "cd examples/terraform-carve-out && ./demo.sh",
        },
        {
          title: "Adopt a resource from state",
          description: "Emit native chant source for a Terraform-managed resource, offline",
          input: "Adopt aws_s3_bucket.assets into chant",
          output: "chant carve emit --from ./terraform --select aws_s3_bucket.assets --state ./terraform/terraform.tfstate",
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
    stack?: string;
    owned?: boolean;
  }): Promise<ObservationResult> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const { observation, unobservedAll } = await import("@intentius/chant/observation");
    const rt = getRuntime();
    const resources: Record<string, ResourceMetadata> = {};

    if (options.owned) {
      // describe-stack-resources does not return tags, so ownership cannot be
      // determined here. Degrade to detect-only rather than silently filtering.
      // eslint-disable-next-line no-console
      console.warn(
        "[aws] ownership filter unavailable on describeResources (no tags from describe-stack-resources) — returning all, each with an explicit `unknown` verdict; use `chant import --from <env> --owned` for ownership-filtered export",
      );
    }

    // Derive stack name. A multi-stack project passes the explicit CloudFormation
    // stack this observation targets (see `stacks` in ChantConfig); otherwise the
    // single-stack convention is the stack named after the environment (#932).
    const stackName = options.stack ?? `${options.environment}`;

    // Describe stack resources. Inject --endpoint-url from AWS_ENDPOINT_URL so a
    // local emulator (Floci) is observed instead of real AWS (#926) — behold
    // serve --local relies on this for the overlay.
    const listResult = await rt.spawn(applyAwsEndpointArgv([
      "aws", "cloudformation", "describe-stack-resources",
      "--stack-name", stackName,
      "--output", "json",
    ], process.env.AWS_ENDPOINT_URL));

    if (listResult.exitCode !== 0) {
      // A stack that doesn't exist yet is the pre-first-apply state: nothing is
      // deployed for this env, so there are no live resources (every declared
      // resource is "pending") — not an error. That is a real absence, so the
      // empty result is the honest one and `create` is the right proposal.
      if (stackDoesNotExist(listResult.stderr)) {
        return observation(resources);
      }
      // Any other failure (credentials, throttling, a region that can't be
      // reached) establishes nothing about what is deployed. Reporting every
      // declared entity as NOT-OBSERVED (#1089) is what keeps a broken read
      // from arriving downstream as "none of this exists".
      const reason = /credential|token|expired|AccessDenied|not authorized|UnauthorizedOperation/i.test(listResult.stderr)
        ? "no-credentials"
        : "read-failed";
      return observation(
        {},
        unobservedAll(
          options.entityNames,
          reason,
          `describe-stack-resources failed for stack "${stackName}": ${listResult.stderr.trim().split("\n")[0] ?? ""}`,
        ),
      );
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
    const describeResult = await rt.spawn(applyAwsEndpointArgv([
      "aws", "cloudformation", "describe-stacks",
      "--stack-name", stackName,
      "--output", "json",
    ], process.env.AWS_ENDPOINT_URL));

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
        // Total verdict (#1089): describe-stack-resources returns no tags, so
        // this path cannot read the ownership marker. Say `unknown` explicitly
        // rather than leaving the field off and letting each consumer guess —
        // the change set never escalates `unknown` to a delete.
        ownership: "unknown",
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      };
    }

    // Every entity the stack answered for was answered for: an entity the
    // template doesn't carry is genuinely not in this stack, which is an
    // absence, not a hole.
    return observation(resources);
  },

  /**
   * Property-level live read (#1015) via the Cloud Control API — past
   * CloudFormation's view of the world, into the resource as the service
   * actually holds it. Implementation in ./deep-observe.ts.
   */
  async observeResourcesDeep(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    stack?: string;
    owned?: boolean;
  }): Promise<DeepObservationResult> {
    return observeResourcesDeepAws({
      environment: options.environment,
      entityNames: options.entityNames,
      entities: options.entities,
      stack: options.stack,
      owned: options.owned,
    });
  },

  /** The noise rules the deep pass applies to both the live and declared trees. */
  deepNormalizationHooks: awsDeepNormalizationHooks,

  async describeStackStatus(options: { environment: string; stack: string }): Promise<StackStatusObservation | null> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();

    const result = await rt.spawn(applyAwsEndpointArgv([
      "aws", "cloudformation", "describe-stacks",
      "--stack-name", options.stack,
      "--output", "json",
    ], process.env.AWS_ENDPOINT_URL));

    if (result.exitCode !== 0) {
      // A stack that doesn't exist yet is the pre-first-apply state (absent, not
      // an error). Any other failure is indeterminate → null, so the caller
      // degrades rather than reporting a healthy stack as gone.
      if (stackDoesNotExist(result.stderr)) return { stack: options.stack, present: false };
      return null;
    }

    const parsed = JSON.parse(result.stdout) as { Stacks?: Array<{ StackStatus?: string }> };
    const status = parsed.Stacks?.[0]?.StackStatus;
    if (!status) return { stack: options.stack, present: false };
    // Healthy = a terminal *success* apply. Rollback/failed/in-progress/delete
    // states are present-but-not-healthy, so a renderer can distinguish
    // deployed-green from mid-deploy or broken.
    const healthy = /^(CREATE|UPDATE|IMPORT)_COMPLETE$/.test(status);
    return { stack: options.stack, present: true, status, healthy };
  },

  async exportResources(options: {
    environment: string;
    stack?: string;
    selector?: ResourceSelector;
    owned?: boolean;
  }): Promise<ExportedTemplate> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();

    // Same stack-name convention as describeResources: an explicit multi-stack
    // stack name (#932), else the stack named after the environment.
    const stackName = options.stack ?? `${options.environment}`;

    const result = await rt.spawn(applyAwsEndpointArgv([
      "aws", "cloudformation", "get-template",
      "--stack-name", stackName,
      "--template-stage", "Original",
      "--output", "json",
    ], process.env.AWS_ENDPOINT_URL));
    if (result.exitCode !== 0) {
      // Not deployed yet → no template to export (nothing live), not an error.
      // Keeps `chant graph --live` edge enrichment and `import --from` quiet
      // before the first apply.
      if (stackDoesNotExist(result.stderr)) {
        return parseStackTemplate({ Resources: {} }, options.selector, options.owned);
      }
      throw new Error(`Failed to get template for stack "${stackName}": ${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout) as { TemplateBody?: unknown };
    if (parsed.TemplateBody === undefined) {
      throw new Error(`Stack "${stackName}" returned no TemplateBody`);
    }

    return parseStackTemplate(parsed.TemplateBody, options.selector, options.owned);
  },

  // Live attribute enrichment for `chant graph --live` edge reconstruction (#784).
  // describe-stack-resources is too thin; the deployed template (exportResources)
  // carries the references. Resolve its `{Ref}`/`{Fn::GetAtt}` intrinsics to bare
  // logical ids so the reference resolver matches them.
  async enrichLiveAttrs(options: { environment: string; stack?: string; owned?: boolean }): Promise<Record<string, Record<string, unknown>>> {
    const template = await this.exportResources!({ environment: options.environment, stack: options.stack, owned: options.owned });
    return resolveTemplateAttrs(template);
  },

  mcpTools() {
    return [
      {
        name: "aws:diff",
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
        uri: "aws:resource-catalog",
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
