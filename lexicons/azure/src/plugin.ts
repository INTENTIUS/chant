import type { LexiconPlugin, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { azureSerializer } from "./serializer";
import { hardcodedLocationRule } from "./lint/rules/hardcoded-location";
import { storageHttpsRule } from "./lint/rules/storage-https";
import { nsgWildcardRule } from "./lint/rules/nsg-wildcard";
import { ArmParser } from "./import/parser";
import { ArmGenerator } from "./import/generator";
import { azureCompletions } from "./lsp/completions";
import { azureHover } from "./lsp/hover";

/**
 * Azure Resource Manager lexicon plugin.
 *
 * Provides serializer, lint rules, template detection,
 * import parsing, and code generation for Azure ARM templates.
 */
export const azurePlugin: LexiconPlugin = {
  name: "azure",
  serializer: azureSerializer,

  lintRules(): LintRule[] {
    return [hardcodedLocationRule, storageHttpsRule, nsgWildcardRule];
  },

  intrinsics(): IntrinsicDef[] {
    return [
      { name: "ResourceId", description: "Generate a resource ID for an Azure resource" },
      { name: "Reference", description: "Get the runtime state of a deployed resource" },
      { name: "Concat", description: "Concatenate multiple string values" },
      { name: "ResourceGroup", description: "Get the current resource group object" },
      { name: "Subscription", description: "Get the current subscription object" },
      { name: "UniqueString", description: "Generate a deterministic hash string" },
      { name: "Format", description: "Format a string with arguments" },
      { name: "If", description: "Conditional expression" },
      { name: "ListKeys", description: "List access keys for a resource" },
    ];
  },

  pseudoParameters(): string[] {
    return [
      "Azure.ResourceGroupName",
      "Azure.ResourceGroupLocation",
      "Azure.ResourceGroupId",
      "Azure.SubscriptionId",
      "Azure.TenantId",
      "Azure.DeploymentName",
    ];
  },

  initTemplates(template?: string) {
    if (template === "web-app") {
      return {
        src: {
          "main.ts": `/**
 * Azure infrastructure — App Service web application
 *
 * Deploys an App Service Plan + Web App with:
 * - Managed identity (SystemAssigned)
 * - HTTPS-only traffic
 * - Minimum TLS 1.2
 * - FTPS disabled
 */

import { AppService } from "@intentius/chant-lexicon-azure";
import { CoreParameter, StackOutput } from "@intentius/chant";

export const environment = new CoreParameter({
  name: "environment",
  type: "string",
  default: "dev",
});

const { plan, webApp } = AppService({
  name: "my-web-app",
  sku: "B1",
  runtime: "NODE|18-lts",
  tags: { environment: "dev" },
});

export { plan, webApp };

export const appUrl = new StackOutput({
  name: "appUrl",
  value: \`https://my-web-app.azurewebsites.net\`,
});
`,
          "tags.ts": `import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-web-app" },
  { key: "Environment", value: "dev" },
]);
`,
        },
      };
    }

    if (template === "aks-cluster") {
      return {
        src: {
          "main.ts": `/**
 * Azure infrastructure — AKS Kubernetes cluster
 *
 * Deploys an AKS cluster with:
 * - Managed identity
 * - RBAC enabled
 * - Standard load balancer
 * - Azure CNI networking
 */

import { AksCluster, VnetDefault, ContainerRegistrySecure } from "@intentius/chant-lexicon-azure";
import { CoreParameter, StackOutput } from "@intentius/chant";

export const kubernetesVersion = new CoreParameter({
  name: "kubernetesVersion",
  type: "string",
  default: "1.28",
});

const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "aks-vnet",
});

const { cluster } = AksCluster({
  name: "my-aks",
  nodeCount: 3,
  vmSize: "Standard_D2s_v5",
  tags: { workload: "kubernetes" },
});

const { registry } = ContainerRegistrySecure({
  name: "myaksacr",
});

export { virtualNetwork, subnet1, subnet2, nsg, routeTable, cluster, registry };

export const clusterName = new StackOutput({
  name: "clusterName",
  value: "my-aks",
});
`,
          "tags.ts": `import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-aks-cluster" },
  { key: "Environment", value: "dev" },
]);
`,
        },
      };
    }

    if (template === "function-app") {
      return {
        src: {
          "main.ts": `/**
 * Azure infrastructure — Consumption Function App
 *
 * Deploys a Function App with:
 * - Consumption (Y1) App Service Plan
 * - Storage Account for function runtime
 * - Managed identity (SystemAssigned)
 * - HTTPS-only traffic
 * - Minimum TLS 1.2
 * - FTPS disabled
 */

import { FunctionApp } from "@intentius/chant-lexicon-azure";
import { CoreParameter, StackOutput } from "@intentius/chant";

export const environment = new CoreParameter({
  name: "environment",
  type: "string",
  default: "dev",
});

const { plan, functionApp, storageAccount } = FunctionApp({
  name: "my-function-app",
  runtime: "node",
  tags: { environment: "dev" },
});

export { plan, functionApp, storageAccount };

export const functionAppUrl = new StackOutput({
  name: "functionAppUrl",
  value: \`https://my-function-app.azurewebsites.net\`,
});
`,
          "tags.ts": `import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-function-app" },
  { key: "Environment", value: "dev" },
]);
`,
        },
      };
    }

    // Default template — basic storage account
    return {
      src: {
        "main.ts": `/**
 * Azure infrastructure — Storage Account with secure defaults
 */

import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";

export const storage = new StorageAccount({
  name: "mystorageaccount",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  supportsHttpsTrafficOnly: true,
  minimumTlsVersion: "TLS1_2",
  allowBlobPublicAccess: false,
});
`,
        "tags.ts": `import { defaultTags } from "@intentius/chant-lexicon-azure";

export const tags = defaultTags([
  { key: "Project", value: "my-app" },
  { key: "Environment", value: "dev" },
]);
`,
      },
    };
  },

  detectTemplate(content: string): boolean {
    try {
      const parsed = JSON.parse(content);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "$schema" in parsed &&
        typeof parsed.$schema === "string" &&
        parsed.$schema.includes("deploymentTemplate") &&
        Array.isArray(parsed.resources)
      );
    } catch {
      return false;
    }
  },

  templateParser(): TemplateParser {
    return new ArmParser();
  },

  templateGenerator(): TypeScriptGenerator {
    return new ArmGenerator();
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-azure.md",
      name: "chant-azure",
      description: "Azure Resource Manager infrastructure generation with chant",
      triggers: [
        { type: "file_pattern", pattern: "*.azure.ts" },
        { type: "context", value: "azure" },
      ],
      parameters: [
        { name: "resourceType", type: "string", description: "Azure resource type to generate" },
      ],
      examples: [
        {
          title: "Storage Account",
          input: "Create an Azure storage account with secure defaults",
          output: 'import { StorageAccount } from "@intentius/chant-lexicon-azure";\n\nexport const storage = new StorageAccount({ ... });',
        },
      ],
    },
    {
      file: "chant-azure-security.md",
      name: "chant-azure-security",
      description: "Azure security best practices for infrastructure",
      triggers: [
        { type: "context", value: "azure security" },
        { type: "context", value: "azure identity" },
      ],
      parameters: [],
      examples: [
        {
          title: "Secure Storage Account",
          input: "Create a storage account with encryption and no public access",
          output: 'import { StorageAccountSecure } from "@intentius/chant-lexicon-azure";\n\nconst { storageAccount } = StorageAccountSecure({ name: "mystorage" });',
        },
      ],
    },
    {
      file: "chant-azure-patterns.md",
      name: "chant-azure-patterns",
      description: "Advanced Azure ARM template patterns",
      triggers: [
        { type: "context", value: "azure patterns" },
        { type: "context", value: "azure composites" },
      ],
      parameters: [],
      examples: [
        {
          title: "Linked Deployment",
          input: "Deploy a child project as a linked template",
          output: 'import { ChildProjectInstance } from "@intentius/chant";\n\nexport const deploy = new ChildProjectInstance({ project: "../network" });',
        },
      ],
    },
    {
      file: "chant-azure-aks.md",
      name: "chant-azure-aks",
      description: "AKS end-to-end workflow — deploy ARM template, configure kubectl, deploy K8s workloads",
      triggers: [
        { type: "context", value: "aks" },
        { type: "context", value: "azure kubernetes" },
        { type: "context", value: "agic" },
      ],
      parameters: [],
      examples: [
        {
          title: "Deploy AKS microservice",
          input: "Deploy an AKS project end-to-end",
          output: "npm run deploy",
        },
      ],
    },
  ]),

  completionProvider() {
    return (ctx: CompletionContext): CompletionItem[] => azureCompletions(ctx);
  },

  hoverProvider() {
    return (ctx: HoverContext): HoverInfo | undefined => azureHover(ctx);
  },

  mcpTools(): McpToolContribution[] {
    return [{
      name: "lookup-resource",
      description: "Look up an Azure resource type by name",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Resource name to search for (e.g. 'StorageAccount', 'VirtualMachine')" },
        },
        required: ["query"],
      },
      handler: async (args: Record<string, unknown>) => {
        const dir = dirname(fileURLToPath(import.meta.url));
        try {
          const lexicon = JSON.parse(
            readFileSync(join(dir, "generated", "lexicon-azure.json"), "utf-8"),
          );
          const query = (args.query as string).toLowerCase();
          const matches = Object.entries(lexicon)
            .filter(([name]) => name.toLowerCase().includes(query))
            .slice(0, 10);
          return JSON.stringify(matches, null, 2);
        } catch {
          return "Lexicon not available — run `bun run generate` first.";
        }
      },
    }];
  },

  mcpResources(): McpResourceContribution[] {
    return [
      {
        uri: "chant://lexicon/azure/catalog",
        name: "Azure Resource Catalog",
        description: "All available Azure resource types",
        mimeType: "application/json",
        handler: async () => {
          const dir = dirname(fileURLToPath(import.meta.url));
          try {
            return readFileSync(join(dir, "generated", "lexicon-azure.json"), "utf-8");
          } catch {
            return "{}";
          }
        },
      },
      {
        uri: "chant://lexicon/azure/examples",
        name: "Azure Example Projects",
        description: "Example project summaries with code snippets for Azure ARM templates",
        mimeType: "application/json",
        handler: async () => {
          const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
          const examplesDir = join(pkgDir, "examples");
          const examples: Array<{ name: string; files: Record<string, string> }> = [];
          try {
            if (!existsSync(examplesDir)) return "[]";
            const dirs = readdirSync(examplesDir, { withFileTypes: true })
              .filter((e: { isDirectory(): boolean }) => e.isDirectory());
            for (const dir of dirs) {
              const exDir = join(examplesDir, dir.name);
              const srcDir = join(exDir, "src");
              const files: Record<string, string> = {};
              const scanDir = existsSync(srcDir) ? srcDir : exDir;
              const entries = readdirSync(scanDir).filter((f: string) => f.endsWith(".ts"));
              for (const f of entries) {
                try {
                  files[f] = readFileSync(join(scanDir, f), "utf-8");
                } catch { /* skip unreadable */ }
              }
              if (Object.keys(files).length > 0) {
                examples.push({ name: dir.name, files });
              }
            }
            return JSON.stringify(examples, null, 2);
          } catch {
            return "[]";
          }
        },
      },
    ];
  },

  async generate(opts) {
    const { generate: gen, writeGeneratedFiles } = await import("./codegen/generate");
    const result = await gen(opts);
    writeGeneratedFiles(result, dirname(dirname(fileURLToPath(import.meta.url))));
    return result;
  },

  async validate(opts) {
    const { validate } = await import("./validate");
    return validate(opts);
  },

  async coverage() {
    const { computeCoverage } = await import("./coverage");
    return computeCoverage();
  },

  async package(opts) {
    const { packageLexicon } = await import("./codegen/package");
    return packageLexicon(opts);
  },
};
