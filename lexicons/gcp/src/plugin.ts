/**
 * GCP Config Connector lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for GCP Config Connector resources.
 */

import { createRequire } from "module";
import type { LexiconPlugin, SkillDefinition, InitTemplateSet, ResourceMetadata } from "@intentius/chant/lexicon";
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
    const { wgc401 } = require("./lint/post-synth/wgc401");
    const { wgc402 } = require("./lint/post-synth/wgc402");
    const { wgc403 } = require("./lint/post-synth/wgc403");
    return [
      wgc101, wgc102, wgc103, wgc104, wgc105, wgc106, wgc107, wgc108, wgc109, wgc110,
      wgc111, wgc112, wgc113,
      wgc201, wgc202, wgc203, wgc204,
      wgc301, wgc302, wgc303,
      wgc401, wgc402, wgc403,
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

  async describeResources(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
  }): Promise<Record<string, ResourceMetadata>> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();
    const resources: Record<string, ResourceMetadata> = {};

    // Convert TypeScript variable names to kebab-case manifest names
    // (mirrors serializer.ts:165 metadata.name assignment)
    function entityToManifestName(name: string): string {
      return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    }

    // Detect namespace: prefer namespace from manifests, then kubectl context, fallback "default"
    let namespace = "default";
    try {
      // Check manifests for an explicit namespace
      const nsMatch = options.buildOutput.match(/^\s+namespace:\s*(.+)$/m);
      if (nsMatch) {
        namespace = nsMatch[1].trim();
      } else {
        // Try kubectl current context namespace
        const nsResult = await rt.spawn([
          "kubectl", "config", "view", "--minify", "-o", "jsonpath={..namespace}",
        ]);
        if (nsResult.exitCode === 0 && nsResult.stdout.trim()) {
          namespace = nsResult.stdout.trim();
        }
      }
    } catch (err) {
      console.error(`[gcp] describeResources: namespace detection failed, using "default": ${err instanceof Error ? err.message : String(err)}`);
    }

    // Parse build output to extract kind/name pairs
    let manifests: Array<{ kind: string; name: string; apiVersion: string; namespace?: string }> = [];
    try {
      const docs = options.buildOutput.split(/^---$/m).filter((d) => d.trim());
      for (const doc of docs) {
        const kindMatch = doc.match(/^kind:\s*(.+)$/m);
        const nameMatch = doc.match(/^\s+name:\s*(.+)$/m);
        const apiVersionMatch = doc.match(/^apiVersion:\s*(.+)$/m);
        if (kindMatch && nameMatch && apiVersionMatch) {
          const nsMatch = doc.match(/^\s+namespace:\s*(.+)$/m);
          manifests.push({
            kind: kindMatch[1].trim(),
            name: nameMatch[1].trim(),
            apiVersion: apiVersionMatch[1].trim(),
            ...(nsMatch && { namespace: nsMatch[1].trim() }),
          });
        }
      }
    } catch (err) {
      console.error(`[gcp] describeResources: failed to parse build output: ${err instanceof Error ? err.message : String(err)}`);
    }

    let resolved = 0;

    for (const entityName of options.entityNames) {
      const manifestName = entityToManifestName(entityName);
      const manifest = manifests.find((m) => m.name === manifestName);
      if (!manifest) {
        console.error(`[gcp] describeResources: no manifest found for entity "${entityName}" (expected manifest name "${manifestName}")`);
        continue;
      }

      const resourceNs = manifest.namespace ?? namespace;
      const resourceType = manifest.kind.toLowerCase();
      const getResult = await rt.spawn([
        "kubectl", "get", resourceType, manifest.name,
        "-n", resourceNs, "-o", "json",
      ]);

      if (getResult.exitCode !== 0) {
        console.error(`[gcp] describeResources: kubectl get ${resourceType} ${manifest.name} -n ${resourceNs} failed (exit ${getResult.exitCode}): ${getResult.stderr.trim()}`);
        continue;
      }

      try {
        const obj = JSON.parse(getResult.stdout) as {
          metadata: { name: string; uid: string; creationTimestamp: string };
          status?: {
            conditions?: Array<{ type: string; status: string }>;
            externalRef?: string;
          };
        };

        let status = "Unknown";
        if (obj.status?.conditions) {
          const ready = obj.status.conditions.find((c) => c.type === "Ready");
          status = ready?.status === "True" ? "Ready" : "NotReady";
        }

        const attributes: Record<string, unknown> = {
          uid: obj.metadata.uid,
        };
        if (obj.status?.externalRef) {
          attributes.externalRef = obj.status.externalRef;
        }

        resources[entityName] = {
          type: `${manifest.apiVersion}/${manifest.kind}`,
          physicalId: obj.status?.externalRef ?? obj.metadata.name,
          status,
          lastUpdated: obj.metadata.creationTimestamp,
          attributes,
        };
        resolved++;
      } catch (err) {
        console.error(`[gcp] describeResources: failed to parse kubectl output for "${entityName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.error(`[gcp] describeResources: ${resolved}/${options.entityNames.length} resources resolved`);
    return resources;
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
