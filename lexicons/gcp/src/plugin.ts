/**
 * GCP Config Connector lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for GCP Config Connector resources.
 */

import { createRequire } from "module";
import type { LexiconPlugin, SkillDefinition, InitTemplateSet } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { gcpSerializer } from "./serializer";

export const gcpPlugin: LexiconPlugin = {
  name: "gcp",
  serializer: gcpSerializer,

  lintRules(): LintRule[] {
    const { hardcodedProjectRule } = require("./lint/rules/hardcoded-project");
    const { hardcodedRegionRule } = require("./lint/rules/hardcoded-region");
    const { publicIamRule } = require("./lint/rules/public-iam");
    return [hardcodedProjectRule, hardcodedRegionRule, publicIamRule];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { wgc101 } = require("./lint/post-synth/wgc101");
    const { wgc102 } = require("./lint/post-synth/wgc102");
    const { wgc103 } = require("./lint/post-synth/wgc103");
    const { wgc104 } = require("./lint/post-synth/wgc104");
    const { wgc105 } = require("./lint/post-synth/wgc105");
    const { wgc106 } = require("./lint/post-synth/wgc106");
    const { wgc107 } = require("./lint/post-synth/wgc107");
    const { wgc108 } = require("./lint/post-synth/wgc108");
    const { wgc109 } = require("./lint/post-synth/wgc109");
    const { wgc110 } = require("./lint/post-synth/wgc110");
    const { wgc201 } = require("./lint/post-synth/wgc201");
    const { wgc202 } = require("./lint/post-synth/wgc202");
    const { wgc203 } = require("./lint/post-synth/wgc203");
    const { wgc204 } = require("./lint/post-synth/wgc204");
    const { wgc301 } = require("./lint/post-synth/wgc301");
    const { wgc302 } = require("./lint/post-synth/wgc302");
    const { wgc303 } = require("./lint/post-synth/wgc303");
    const { wgc111 } = require("./lint/post-synth/wgc111");
    const { wgc112 } = require("./lint/post-synth/wgc112");
    const { wgc113 } = require("./lint/post-synth/wgc113");
    return [
      wgc101, wgc102, wgc103, wgc104, wgc105, wgc106, wgc107, wgc108, wgc109, wgc110,
      wgc111, wgc112, wgc113,
      wgc201, wgc202, wgc203, wgc204,
      wgc301, wgc302, wgc303,
    ];
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
  removeDefaultNodePool: true,
  releaseChannel: { channel: "REGULAR" },
  workloadIdentityConfig: {
    workloadPool: "PROJECT_ID.svc.id.goog",
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
    if (typeof data !== "object" || data === null) return false;

    // Handle parsed YAML objects
    const obj = data as Record<string, unknown>;
    const apiVersion = obj.apiVersion;
    if (typeof apiVersion === "string" && apiVersion.includes("cnrm.cloud.google.com")) {
      return true;
    }

    // Handle string input
    if (typeof data === "string") {
      return data.includes("cnrm.cloud.google.com");
    }

    return false;
  },

  templateParser(): TemplateParser {
    const { GcpParser } = require("./import/parser");
    return new GcpParser();
  },

  templateGenerator(): TypeScriptGenerator {
    const { GcpGenerator } = require("./import/generator");
    return new GcpGenerator();
  },

  completionProvider(ctx: CompletionContext): CompletionItem[] {
    const { gcpCompletions } = require("./lsp/completions");
    return gcpCompletions(ctx);
  },

  hoverProvider(ctx: HoverContext): HoverInfo | undefined {
    const { gcpHover } = require("./lsp/hover");
    return gcpHover(ctx);
  },

  mcpTools(): McpToolContribution[] {
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for GCP Config Connector manifests",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to the infrastructure project directory",
            },
          },
          required: ["path"],
        },
        async handler(params: Record<string, unknown>): Promise<unknown> {
          const { diffCommand } = await import("@intentius/chant/cli/commands/diff");
          const result = await diffCommand({
            path: (params.path as string) ?? ".",
            serializers: [gcpSerializer],
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
        name: "GCP Config Connector Resource Catalog",
        description: "JSON list of all supported GCP Config Connector resource types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-gcp.json") as Record<string, { resourceType: string; kind: string }>;
          const entries = Object.entries(lexicon).map(([className, entry]) => ({
            className,
            resourceType: entry.resourceType,
            kind: entry.kind,
          }));
          return JSON.stringify(entries);
        },
      },
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

  skills(): SkillDefinition[] {
    const { readFileSync } = require("fs");
    const { join, dirname } = require("path");
    const { fileURLToPath } = require("url");
    const dir = dirname(fileURLToPath(import.meta.url));

    const skills: SkillDefinition[] = [];

    const skillFiles = [
      {
        file: "chant-gcp.md",
        name: "chant-gcp",
        description: "GCP Config Connector lifecycle — build, lint, apply, and troubleshoot from a chant project",
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
        file: "chant-gke.md",
        name: "chant-gke",
        description: "GKE end-to-end workflow — bootstrap cluster, deploy Config Connector resources, deploy K8s workloads",
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
    ];

    for (const skill of skillFiles) {
      try {
        const content = readFileSync(join(dir, "skills", skill.file), "utf-8");
        skills.push({
          name: skill.name,
          description: skill.description,
          content,
          triggers: skill.triggers,
          parameters: skill.parameters,
          examples: skill.examples,
        });
      } catch { /* skip missing skills */ }
    }

    return skills;
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
};
