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
    return [wgc101, wgc102, wgc103, wgc104];
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
    return [
      {
        name: "chant-gcp",
        description: "GCP Config Connector lifecycle — build, lint, apply, and troubleshoot from a chant project",
        content: `---
skill: chant-gcp
description: Build, validate, and deploy GCP Config Connector manifests from a chant project
source: chant-lexicon
user-invocable: true
---

# GCP Config Connector Operational Playbook

## How chant and Config Connector relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into Config Connector YAML manifests. chant does NOT call GCP APIs. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **kubectl** for: apply, rollback, monitoring, troubleshooting

The source of truth for infrastructure is the TypeScript in \`src/\`. The generated YAML manifests are intermediate artifacts.

## Prerequisites

1. A GKE cluster with Config Connector installed
2. A ConfigConnectorContext resource per namespace
3. A GCP Service Account with appropriate IAM roles

## Build and validate

### Build manifests

\`\`\`bash
chant build src/ --output manifests.yaml
\`\`\`

### Lint the source

\`\`\`bash
chant lint src/
\`\`\`

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| \`chant lint\` | Hardcoded project IDs (WGC001), regions (WGC002), public IAM (WGC003) | Every edit |
| \`chant build\` | Post-synth: missing encryption (WGC101), public IAM in output (WGC102), missing project annotation (WGC103) | Before apply |

## Applying to Kubernetes

\`\`\`bash
# Build
chant build src/ --output manifests.yaml

# Dry run
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
\`\`\`

## Resource reference patterns

Config Connector resources reference each other using \`resourceRef\`:

\`\`\`yaml
# By name (same namespace)
resourceRef:
  name: my-network

# By external reference (cross-project)
resourceRef:
  external: projects/my-project/global/networks/my-network
\`\`\`

## Project binding

Bind resources to a GCP project via annotations:

\`\`\`yaml
metadata:
  annotations:
    cnrm.cloud.google.com/project-id: my-project
\`\`\`

Or use defaultAnnotations in chant:

\`\`\`typescript
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
\`\`\`

## Troubleshooting

| Status | Meaning | Fix |
|--------|---------|-----|
| UpToDate | Resource is in sync | None needed |
| UpdateFailed | GCP API error | Check \`kubectl describe\` events |
| DependencyNotReady | Waiting for referenced resource | Ensure dependency exists |
| DeletionFailed | Cannot delete GCP resource | Check IAM permissions |

## Quick reference

| Command | Description |
|---------|-------------|
| \`chant build src/\` | Synthesize manifests |
| \`chant lint src/\` | Check for anti-patterns |
| \`kubectl apply -f manifests.yaml\` | Apply to cluster |
| \`kubectl get gcp\` | List all Config Connector resources |
| \`kubectl describe <resource>\` | Check reconciliation status |
`,
        triggers: [
          { type: "file-pattern", value: "*.gcp.ts" },
          { type: "context", value: "gcp" },
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
    ];
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
