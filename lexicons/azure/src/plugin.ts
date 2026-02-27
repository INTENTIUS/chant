import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, SkillDefinition } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { TemplateParser } from "@intentius/chant/import/parser";
import type { TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { azureSerializer } from "./serializer";

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
    const { hardcodedLocationRule } = require("./lint/rules/hardcoded-location");
    const { storageHttpsRule } = require("./lint/rules/storage-https");
    const { nsgWildcardRule } = require("./lint/rules/nsg-wildcard");
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
    const { ArmParser } = require("./import/parser");
    return new ArmParser();
  },

  templateGenerator(): TypeScriptGenerator {
    const { ArmGenerator } = require("./import/generator");
    return new ArmGenerator();
  },

  postSynthChecks(): PostSynthCheck[] {
    const checks: PostSynthCheck[] = [];
    const loadCheck = (path: string, name: string) => {
      try {
        const mod = require(path);
        if (mod[name]) checks.push(mod[name]);
      } catch { /* skip */ }
    };
    loadCheck("./lint/post-synth/azr010", "azr010");
    loadCheck("./lint/post-synth/azr011", "azr011");
    loadCheck("./lint/post-synth/azr012", "azr012");
    loadCheck("./lint/post-synth/azr013", "azr013");
    loadCheck("./lint/post-synth/azr014", "azr014");
    loadCheck("./lint/post-synth/azr015", "azr015");
    return checks;
  },

  skills(): SkillDefinition[] {
    const { readFileSync } = require("fs");
    const { join, dirname } = require("path");
    const { fileURLToPath } = require("url");
    const dir = dirname(fileURLToPath(import.meta.url));

    try {
      const content = readFileSync(join(dir, "skills", "chant-azure.md"), "utf-8");
      return [{
        name: "chant-azure",
        description: "Azure Resource Manager infrastructure generation",
        content,
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
      }];
    } catch {
      return [];
    }
  },

  completionProvider() {
    return (ctx: CompletionContext): CompletionItem[] => {
      const { azureCompletions } = require("./lsp/completions");
      return azureCompletions(ctx);
    };
  },

  hoverProvider() {
    return (ctx: HoverContext): HoverInfo | undefined => {
      const { azureHover } = require("./lsp/hover");
      return azureHover(ctx);
    };
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
        const { readFileSync } = require("fs");
        const { join, dirname } = require("path");
        const { fileURLToPath } = require("url");
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
    return [{
      uri: "chant://lexicon/azure/catalog",
      name: "Azure Resource Catalog",
      description: "All available Azure resource types",
      mimeType: "application/json",
      handler: async () => {
        const { readFileSync } = require("fs");
        const { join, dirname } = require("path");
        const { fileURLToPath } = require("url");
        const dir = dirname(fileURLToPath(import.meta.url));
        try {
          return readFileSync(join(dir, "generated", "lexicon-azure.json"), "utf-8");
        } catch {
          return "{}";
        }
      },
    }];
  },

  async generate(opts) {
    const { generate: gen, writeGeneratedFiles } = require("./codegen/generate");
    const { dirname: d } = require("path");
    const { fileURLToPath: fu } = require("url");
    const result = await gen(opts);
    writeGeneratedFiles(result, d(d(fu(import.meta.url))));
    return result;
  },

  async validate(opts) {
    const { validate } = require("./validate");
    return validate(opts);
  },

  async coverage() {
    const { computeCoverage } = require("./coverage");
    return computeCoverage();
  },

  async package(opts) {
    const { packageLexicon } = require("./codegen/package");
    return packageLexicon(opts);
  },
};
