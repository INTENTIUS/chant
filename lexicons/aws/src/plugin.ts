import { createRequire } from "module";
import { detectTemplate } from "./detect";
import type { LexiconPlugin, IntrinsicDef, ObservationResult, DeepObservationResult, DependencyObservation, DescribeIdentityOptions, DescribeIdentityResult, DisruptionQuery, DisruptionVerdict, ResourceMetadata, ExportedTemplate, ResourceSelector, InitTemplateSet, StackStatusObservation } from "@intentius/chant/lexicon";
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
import {
  AwsReadError,
  describeStackDetail,
  describeStackResources,
  type AwsReadClientOptions,
  type StackResource,
} from "./api/read-client";
import { awsDeepNormalizationHooks, observeResourcesDeepAws } from "./deep-observe";
import { awsDisruption } from "./disruption";
import { awsReferenceCatalog } from "./reference-catalog";
import { AMBIENT_KINDS } from "./ambient";
import { canDescribe, describeOwnProperties, stampRegion } from "./properties";
import { stampProviderDefaults } from "./defaults";
import { resolveTemplateAttrs } from "./live-attrs";
import { CFParser } from "./import/parser";
import { CFGenerator } from "./import/generator";
import { parseStackTemplate } from "./import/live-export";
import { awsCompletions } from "./lsp/completions";
import { awsHover } from "./lsp/hover";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";
import { readOwnership } from "@intentius/chant/ownership";

/** Re-exported from ./stack-errors so the long-standing import path (and its
 * tests) keep working now that the deep reader shares the classifier. */
export { stackDoesNotExist } from "./stack-errors";

/**
 * AWS CloudFormation lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for AWS CloudFormation.
 */
/**
 * The stack's own tags did not resolve a marker for this read, so `owned: true`
 * withheld nothing. Returned as a run-level note rather than printed (#1265):
 * core says it once per run, after the answer, however many stacks were read.
 * The text is the contract consumers grep for.
 */
const OWNERSHIP_UNRESOLVED_NOTE =
  "ownership filter not applied on describeResources (this stack's own tags carry no chant marker, or DescribeStacks did not answer) — returning all, each with the verdict the read supports; use `chant import --from <env> --owned` for ownership-filtered export";

export const awsPlugin: LexiconPlugin = {
  name: "aws",
  // The thin read's marker channel is the STACK's own tags (#1998), read off
  // the DescribeStacks call it already makes for the outputs.
  // describe-stack-resources carries no per-resource tags, so the stack is the
  // granularity — the same boundary teardown verifies on (#1222).
  ownershipChannel: {
    keys: AWS_TAG_OWNERSHIP_KEYS,
    reads: ["describeResources", "observeResourcesDeep", "exportResources"],
  },
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
      description: "Demo carving a resource out of Terraform into native chant — advise, emit, audit, bridge, apply — fully offline",
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
    entities?: Map<string, { entityType: string; props: Record<string, unknown> }>;
    stack?: string;
    region?: string;
    owned?: boolean;
  }): Promise<ObservationResult> {
    const { observation, unobservedAll } = await import("@intentius/chant/observation");
    const resources: Record<string, ResourceMetadata> = {};
    // The applier's own transport, pointed at the read APIs (#1206). Multi-region
    // estates target this stack's region, not the ambient one.
    const client: AwsReadClientOptions = {
      ...(options.region ? { region: options.region } : {}),
    };

    // The note for the read paths that never reach the stack's tags at all: a
    // missing stack, and a failed stack read. Core dedupes it across stacks and
    // prints it once per run with the footer, rather than ahead of every answer
    // (#1265).
    const unresolvedNotes = options.owned ? [OWNERSHIP_UNRESOLVED_NOTE] : undefined;

    // Derive stack name. A multi-stack project passes the explicit CloudFormation
    // stack this observation targets (see `stacks` in ChantConfig); otherwise the
    // single-stack convention is the stack named after the environment (#932).
    const stackName = options.stack ?? `${options.environment}`;

    // Effect receipt rows (#1835): a receipt is never a stack member (the
    // applier never writes it, #1832), so the stack read honestly reports it
    // absent even while the parameter exists — which would arrive downstream
    // as "the effect never ran". The serializer rendered each receipt's
    // derived path into the template Metadata; read those parameters directly,
    // and report a failed read as an `unobserved` hole rather than a wrong
    // answer.
    const { observeReceiptRows } = await import("./receipt-store");
    const receiptObs = await observeReceiptRows(options.entityNames, options.buildOutput, client);
    const receiptHoles = Object.keys(receiptObs.unobserved).length > 0 ? receiptObs.unobserved : undefined;

    // Describe stack resources. The endpoint override rides the client, so a
    // local emulator (Floci) is observed instead of real AWS (#926) — behold
    // serve --local relies on this for the overlay.
    let stackResources: StackResource[];
    try {
      stackResources = await describeStackResources(stackName, client);
    } catch (err) {
      // A stack that doesn't exist yet is the pre-first-apply state: nothing is
      // deployed for this env, so there are no live resources (every declared
      // resource is "pending") — not an error. That is a real absence, so the
      // empty result is the honest one and `create` is the right proposal —
      // EXCEPT for an entity whose props spell its own physical identity
      // (#1647): a freshly carve-emitted, still-Terraform-owned resource lives
      // in no stack at all, and only an identity read can see it.
      if (err instanceof AwsReadError && stackDoesNotExist(err.message)) {
        const { observeByIdentity } = await import("./identity-observe");
        const identity = await observeByIdentity(options.entityNames, options.entities, resources, client);
        return observation(
          { ...resources, ...identity.resources, ...receiptObs.resources },
          receiptHoles,
          identity.queried,
          unresolvedNotes,
        );
      }
      // Any other failure (credentials, throttling, a region that can't be
      // reached) establishes nothing about what is deployed. Reporting every
      // declared entity as NOT-OBSERVED (#1089) is what keeps a broken read
      // from arriving downstream as "none of this exists".
      const detail = err instanceof AwsReadError && err.code ? `${err.code}: ${err.message}` : String(err instanceof Error ? err.message : err);
      const reason = /credential|token|expired|AccessDenied|not authorized|Unauthorized/i.test(detail)
        ? "no-credentials"
        : "read-failed";
      // A receipt row the leg above did read stays read: its answer came from
      // GetParameter, not from the failed stack call, so it is not a hole.
      const stackHoles = unobservedAll(
        options.entityNames.filter((n) => !(n in receiptObs.resources)),
        reason,
        `DescribeStackResources failed for stack "${stackName}": ${detail}`,
      );
      return observation(
        { ...receiptObs.resources },
        { ...stackHoles, ...receiptObs.unobserved },
        undefined,
        unresolvedNotes,
      );
    }

    // Map logical names from build to stack resources
    const stackResourceMap = new Map(stackResources.map((r) => [r.logicalId, r]));

    // Get the stack's outputs and its own tags — one DescribeStacks call. A
    // stack whose resources read fine but whose DescribeStacks does not is
    // still a usable observation, so this failure is swallowed exactly as the
    // non-zero exit code used to be. `undefined` tags mean the call did not
    // answer, which is an unread channel rather than an absent marker.
    let stackOutputs: Record<string, string> = {};
    let stackTags: Record<string, string> | undefined;
    try {
      const detail = await describeStackDetail(stackName, client);
      stackOutputs = detail.outputs;
      stackTags = detail.tags;
    } catch {
      stackOutputs = {};
      stackTags = undefined;
    }

    // The marker channel on this path (#1998). describe-stack-resources carries
    // no per-resource tags, but the stack's own tags carry the identity the
    // apply paths stamped from the template's `Metadata["chant:ownership"]`
    // block — the same channel teardown verifies on (#1222). Every member of a
    // marked stack belongs to that stack's identity, so the verdict and the
    // marker are the stack's, read back verbatim.
    const stackMarker = stackTags ? readOwnership(stackTags, AWS_TAG_OWNERSHIP_KEYS) : undefined;
    const stackOwnership: ResourceMetadata["ownership"] =
      stackTags === undefined ? "unknown" : stackMarker ? "owned" : "foreign";
    // `owned: true` withheld nothing, so say why whenever the marker did not resolve.
    const notes = options.owned && stackMarker === undefined ? unresolvedNotes : undefined;

    // The outputs are the stack's, not any member's (#1279). They used to be
    // copied onto every resource's `attributes`, so a VPC carried the stack's
    // `expWebIp` and no `CidrBlock`. They ride the envelope once, keyed by the
    // stack, scrubbed of anything that looks secret.
    const exports: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stackOutputs)) {
      exports[key] = /password|secret|token|key/i.test(key) ? "[REDACTED]" : value;
    }
    const stackExports = Object.keys(exports).length > 0 ? { [stackName]: exports } : undefined;

    for (const entityName of options.entityNames) {
      const stackResource = stackResourceMap.get(entityName);
      if (!stackResource) continue;

      resources[entityName] = {
        type: stackResource.type,
        physicalId: stackResource.physicalId ?? "",
        status: stackResource.status ?? "",
        lastUpdated: stackResource.timestamp ?? "",
        // Total verdict (#1089), from the stack's own tags. `unknown` is kept
        // for the one case that earns it — DescribeStacks did not answer, so
        // the channel was never read — and the change set never escalates
        // `unknown` to a delete. `marker` is set only where the stack really
        // carries one: absent means absent, never a guess.
        ownership: stackOwnership,
        ...(stackMarker ? { marker: stackMarker } : {}),
      };
    }

    // The identity fallback (#1647): entities the stack did not answer for but
    // whose declared props spell a full primary identifier get a Cloud Control
    // read before "absent" stands. Computed against the stack's answer and
    // merged at the return sites, so the own-property enrichment below neither
    // re-describes nor un-observes what identity found.
    const { observeByIdentity } = await import("./identity-observe");
    const identity = await observeByIdentity(options.entityNames, options.entities, resources, client);

    // Each resource's OWN properties (#1279). Until this, a node's `attrs` were
    // the stack's exports replicated onto every member, so no instance carried
    // its own `VpcId`.
    const own = await describeOwnProperties(resources, options.region);
    const withProperties = stampProviderDefaults(stampRegion(own.resources, options.region));

    // The own-property read is still a CLI shell-out while the stack reads are
    // not (#1206), so the two halves can now fail independently. When the
    // enrichment could not run at all, the resources it would have described are
    // identified but not described — and `lifecycle diff` compares these
    // attributes, so presenting them anyway reports every previously-recorded
    // property as removed. That is a failed read arriving as drift, which is the
    // shape #1089 exists to prevent, so say it is a hole instead.
    const undescribed = own.transportFailed
      ? Object.keys(withProperties).filter((name) => canDescribe(withProperties[name].type))
      : [];
    if (undescribed.length > 0) {
      const described: Record<string, ResourceMetadata> = {};
      for (const [name, meta] of Object.entries(withProperties)) {
        if (!undescribed.includes(name)) described[name] = meta;
      }
      // Attribute each hole to the call that failed for *its* kind, rather than
      // to whichever call happened to fail first.
      const holes: Record<string, { type: string; reason: "read-failed"; detail: string }> = {};
      for (const name of undescribed) {
        const type = withProperties[name].type;
        holes[name] = {
          type,
          reason: "read-failed",
          detail: `the stack was read, but this resource's own properties were not — ${own.failures.get(type) ?? "the describe call failed"}`,
        };
      }
      return observation(
        { ...described, ...identity.resources, ...receiptObs.resources },
        { ...holes, ...receiptObs.unobserved },
        identity.queried,
        notes,
        stackExports,
      );
    }

    // Every entity the stack answered for was answered for: an entity the
    // template doesn't carry is genuinely not in this stack, which is an
    // absence, not a hole — unless the identity fallback saw it live (#1647).
    return observation(
      { ...withProperties, ...identity.resources, ...receiptObs.resources },
      receiptHoles,
      identity.queried,
      notes,
      stackExports,
    );
  },

  /**
   * Property-level live read (#1015) via the Cloud Control API — past
   * CloudFormation's view of the world, into the resource as the service
   * actually holds it. Implementation in ./deep-observe.ts.
   */
  /**
   * The routing this estate depends on but does not declare (#1273) — an
   * instance in the account's default VPC routes through a table nobody wrote.
   * Reporting the resources lets the graph fold derive `internetFacing`, rather
   * than this lexicon computing it and injecting the conclusion.
   */
  async observeDependencies(options: {
    environment: string;
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    observed: Record<string, ResourceMetadata>;
    stack?: string;
    region?: string;
  }): Promise<DependencyObservation> {
    const { observeAwsDependencies } = await import("./dependencies");
    return observeAwsDependencies({ observed: options.observed, region: options.region });
  },

  /**
   * What a pending update costs (#1665), read off the Registry schema the
   * codegen already compiled: a changed `createOnlyProperties` entry is a
   * replacement, and `replacementStrategy: delete_then_create` makes it a
   * destroy. A conditionally-create-only property is `unknown` on purpose —
   * the schema says "depends on the value", which is not an answer.
   */
  classifyDisruption(options: {
    environment: string;
    changes: DisruptionQuery[];
  }): Record<string, DisruptionVerdict> {
    return awsDisruption(options);
  },

  /**
   * Who chant would act as here, before it acts (#1982) —
   * `sts:GetCallerIdentity` on the same transport, endpoint override and
   * region resolution `describeResources` uses, so the principal reported and
   * the account read are the same one. Implementation in ./caller-identity.ts.
   */
  async describeIdentity(options: DescribeIdentityOptions): Promise<DescribeIdentityResult> {
    const { describeIdentity } = await import("./caller-identity");
    return describeIdentity(options);
  },

  /**
   * Resources of a managed kind that exist without being declared or
   * referenced (#1278) — the account's default security groups, an unattached
   * one someone left behind. Nothing else in the observation can see them,
   * because everything else resolves outward from what is declared.
   */
  /** #1278 — the kinds `observeAmbient` can enumerate, from the same source. */
  ambientKinds(): string[] {
    return AMBIENT_KINDS;
  },

  async observeAmbient(options: {
    environment: string;
    kinds: string[];
    observed: Record<string, ResourceMetadata>;
    stack?: string;
    region?: string;
  }): Promise<Record<string, ResourceMetadata>> {
    const { observeAwsAmbient } = await import("./ambient");
    return observeAwsAmbient({ kinds: options.kinds, observed: options.observed, region: options.region });
  },

  async observeResourcesDeep(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    stack?: string;
    region?: string;
    owned?: boolean;
  }): Promise<DeepObservationResult> {
    return observeResourcesDeepAws({
      environment: options.environment,
      entityNames: options.entityNames,
      entities: options.entities,
      stack: options.stack,
      region: options.region,
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

  // Env teardown at STACK granularity (#1222): `describeResources` carries no
  // tags, so per-resource marker selection is impossible here — the env's
  // stacks are enumerated instead (`stacks[]`, else the env-named default) and
  // ownership is verified on each stack's own DescribeStacks tags. Execution
  // is DeleteStack via the applier's `awsDelete`. See ./teardown.ts.
  async teardownOwned(options) {
    const { teardownOwned } = await import("./teardown");
    return teardownOwned(options);
  },

  async executeTeardown(options) {
    const { executeTeardown } = await import("./teardown");
    return executeTeardown(options);
  },

  async exportResources(options: {
    environment: string;
    stack?: string;
    region?: string;
    selector?: ResourceSelector;
    owned?: boolean;
  }): Promise<ExportedTemplate> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();

    // Same stack-name convention as describeResources: an explicit multi-stack
    // stack name (#932), else the stack named after the environment.
    const stackName = options.stack ?? `${options.environment}`;
    const regionArgs = options.region ? ["--region", options.region] : [];

    const result = await rt.spawn(applyAwsEndpointArgv([
      "aws", "cloudformation", "get-template",
      "--stack-name", stackName,
      ...regionArgs,
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
  async enrichLiveAttrs(options: { environment: string; stack?: string; stacks?: Array<string | { name: string; region?: string }>; owned?: boolean }): Promise<Record<string, Record<string, unknown>>> {
    // Multi-stack (#1161): a project declaring ChantConfig.stacks passes them
    // here; enrich per-stack and merge. Otherwise the single-stack convention.
    const stackRefs = options.stacks && options.stacks.length > 0
      ? options.stacks.map((st) => (typeof st === "string" ? { name: st } : st))
      : [{ name: options.stack ?? options.environment }];
    const merged: Record<string, Record<string, unknown>> = {};
    const multi = options.stacks && options.stacks.length > 0;
    for (const ref of stackRefs) {
      try {
        const template = await this.exportResources!({ environment: options.environment, stack: ref.name, region: ref.region, owned: options.owned });
        const attrs = resolveTemplateAttrs(template);
        // Stack-qualify keys to match the observed node ids (#1162).
        for (const [logicalId, v] of Object.entries(attrs)) {
          merged[multi ? `${ref.name}::${logicalId}` : logicalId] = v;
        }
      } catch {
        // A stack that isn't deployed yet contributes no live attrs — skip it.
      }
    }
    return merged;
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
