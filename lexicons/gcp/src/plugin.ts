/**
 * GCP Config Connector lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for GCP Config Connector resources.
 */

import type { LexiconPlugin, InitTemplateSet, ResourceMetadata } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import { postSynthChecks as postSynthCheckList } from "./lint/post-synth";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gcpSerializer } from "./serializer";
import { hardcodedProjectRule } from "./lint/rules/hardcoded-project";
import { hardcodedRegionRule } from "./lint/rules/hardcoded-region";
import { publicIamRule } from "./lint/rules/public-iam";
import { GcpParser } from "./import/parser";
import { GcpGenerator } from "./import/generator";
import { gcpCompletions } from "./lsp/completions";
import { gcpHover } from "./lsp/hover";

export const gcpPlugin: LexiconPlugin = {
  name: "gcp",
  serializer: gcpSerializer,

  lintRules(): LintRule[] {
    return [hardcodedProjectRule, hardcodedRegionRule, publicIamRule];
  },

  postSynthChecks() {
    return postSynthCheckList;
  },

  intrinsics() {
    // Config Connector YAML has no intrinsic template functions
    return [];
  },

  pseudoParameters(): string[] {
    return [
      "GCP::ProjectId",
      "GCP::Region",
      "GCP::Zone",
    ];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "gke") {
      return {
        src: {
          "infra.ts": `/**
 * GKE Cluster + Node Pool + Workload Identity
 */

import { GKECluster, NodePool, GCPServiceAccount, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const cluster = new GKECluster({
  location: GCP.Region,
  initialNodeCount: 1,
  releaseChannel: { channel: "REGULAR" },
  workloadIdentityConfig: {
    workloadPool: \`\${GCP.ProjectId}.svc.id.goog\`,
  },
});

export const nodePool = new NodePool({
  clusterRef: { name: cluster },
  initialNodeCount: 2,
  autoscaling: { minNodeCount: 1, maxNodeCount: 10 },
  nodeConfig: {
    machineType: "e2-medium",
    diskSizeGb: 100,
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    workloadMetadataConfig: { mode: "GKE_METADATA" },
  },
  management: { autoRepair: true, autoUpgrade: true },
});
`,
        },
      };
    }

    if (template === "cloud-function") {
      return {
        src: {
          "infra.ts": `/**
 * Cloud Function with Pub/Sub trigger
 */

import { CloudFunction, StorageBucket, GCPServiceAccount, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const sourceBucket = new StorageBucket({
  location: GCP.Region,
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
});

export const functionSa = new GCPServiceAccount({
  displayName: "Cloud Function Service Account",
});

export const fn = new CloudFunction({
  location: GCP.Region,
  runtime: "nodejs22",
  entryPoint: "handler",
  sourceArchiveBucket: sourceBucket,
  sourceArchiveObject: "function-source.zip",
  triggerHttp: true,
  serviceAccountEmail: functionSa,
});

export const invoker = new IAMPolicyMember({
  member: "allUsers",
  role: "roles/cloudfunctions.invoker",
  resourceRef: {
    apiVersion: "cloudfunctions.cnrm.cloud.google.com/v1beta1",
    kind: "CloudFunction",
    name: fn,
  },
});
`,
        },
      };
    }

    // Default: StorageBucket + IAMPolicyMember
    return {
      src: {
        "infra.ts": `/**
 * GCS Bucket with encryption and IAM binding
 */

import { StorageBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const dataBucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});

export const bucketReader = new IAMPolicyMember({
  member: "serviceAccount:my-app@PROJECT_ID.iam.gserviceaccount.com",
  role: "roles/storage.objectViewer",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: dataBucket,
  },
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    // Handle raw string input (unparsed YAML)
    if (typeof data === "string") {
      return data.includes("cnrm.cloud.google.com");
    }

    // Handle parsed YAML objects
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;
    const apiVersion = obj.apiVersion;
    if (typeof apiVersion === "string" && apiVersion.includes("cnrm.cloud.google.com")) {
      return true;
    }

    return false;
  },

  templateParser(): TemplateParser {
    return new GcpParser();
  },

  templateGenerator(): TypeScriptGenerator {
    return new GcpGenerator();
  },

  completionProvider(ctx: CompletionContext): CompletionItem[] {
    return gcpCompletions(ctx);
  },

  hoverProvider(ctx: HoverContext): HoverInfo | undefined {
    return gcpHover(ctx);
  },

  mcpTools() {
    return [createDiffTool(gcpSerializer, "Compare current build output against previous output for GCP Config Connector manifests", "gcp")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "GCP Config Connector Resource Catalog", "JSON list of all supported GCP Config Connector resource types", "lexicon-gcp.json", "gcp"),
      {
        uri: "examples/basic-bucket",
        name: "Basic GCS Bucket Example",
        description: "A GCS bucket with encryption and IAM binding",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { StorageBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const bucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});
`;
        },
      },
    ];
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-gcp.md",
      name: "chant-gcp",
      description: "Build, validate, and deploy GCP Config Connector manifests from a chant project",
      triggers: [
        { type: "file-pattern" as const, value: "*.gcp.ts" },
        { type: "context" as const, value: "gcp" },
      ],
      parameters: [
        {
          name: "resourceType",
          type: "string",
          description: "GCP Config Connector resource type to work with",
        },
      ],
      examples: [
        {
          title: "Create a Storage Bucket",
          output: "new StorageBucket({ location: \"US\", storageClass: \"STANDARD\" })",
        },
        {
          title: "Create a GKE Cluster",
          output: "new GKECluster({ location: GCP.Region, releaseChannel: { channel: \"REGULAR\" } })",
        },
      ],
    },
    {
      file: "chant-gcp-security.md",
      name: "chant-gcp-security",
      description: "GCP security best practices for infrastructure",
      triggers: [
        { type: "context" as const, value: "gcp security" },
        { type: "context" as const, value: "gcp iam" },
      ],
      parameters: [],
      examples: [
        {
          title: "Secure Storage Bucket",
          input: "Create a storage bucket with encryption and uniform access",
          output: "import { GcsBucket } from \"@intentius/chant-lexicon-gcp\";\n\nconst { bucket } = GcsBucket({ name: \"my-bucket\", kmsKeyName: \"...\" });",
        },
      ],
    },
    {
      file: "chant-gcp-patterns.md",
      name: "chant-gcp-patterns",
      description: "Advanced GCP Config Connector patterns",
      triggers: [
        { type: "context" as const, value: "gcp patterns" },
        { type: "context" as const, value: "gcp composites" },
      ],
      parameters: [],
      examples: [
        {
          title: "VPC with Subnets",
          input: "Create a VPC network with private subnets",
          output: "import { VpcNetwork } from \"@intentius/chant-lexicon-gcp\";\n\nconst { network, subnets } = VpcNetwork({ name: \"my-vpc\", subnets: [...] });",
        },
      ],
    },
    {
      file: "chant-gcp-gke.md",
      name: "chant-gcp-gke",
      description: "End-to-end GKE workflow bridging GCP infrastructure and Kubernetes workloads",
      triggers: [
        { type: "context" as const, value: "gke" },
        { type: "context" as const, value: "gcp kubernetes" },
        { type: "context" as const, value: "config connector" },
      ],
      parameters: [],
      examples: [
        {
          title: "Deploy GKE microservice",
          input: "Deploy a GKE project end-to-end",
          output: "npm run bootstrap && npm run deploy",
        },
      ],
    },
  ]),

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
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeGcpCoverage } = await import("./coverage");
    await analyzeGcpCoverage({
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
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

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

  async exportResources(options) {
    const { exportResources } = await import("./export-resources");
    return exportResources(options);
  },
};
