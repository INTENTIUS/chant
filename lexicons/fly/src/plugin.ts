import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { flySerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * fly lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const flyPlugin: LexiconPlugin = {
  name: "fly",
  serializer: flySerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    // TODO: Implement coverage analysis
    console.error("Coverage analysis not yet implemented");
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  // ── Optional extensions ────────────────────────────────────

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-fly.md",
      name: "chant-fly",
      description: "Author, lint, and deploy Fly apps and machines from a chant project, applied straight to the Machines API",
      triggers: [
        { type: "file-pattern" as const, value: "*.fly.ts" },
        { type: "context" as const, value: "fly" },
        { type: "context" as const, value: "fly.io" },
      ],
      parameters: [
        {
          name: "resourceType",
          type: "string",
          description: "Fly resource type to work with (App, Machine, Volume, IPAddress, Certificate, Secret)",
        },
      ],
      examples: [
        {
          title: "Author an App and a Machine",
          output: "new App({ name: \"my-app\" });\nnew Machine({ region: \"iad\", config: new MachineConfig({ image: \"flyio/hellofly:latest\" }) })",
        },
        {
          title: "Deploy against mudflaps offline",
          input: "Apply the App + Machine without a Fly account",
          output: "cd examples/local-fly && chant run fly",
        },
      ],
    },
    {
      file: "chant-fly-patterns.md",
      name: "chant-fly-patterns",
      description: "Volumes and mounts, IP assignments, certificates, apply-only secrets, and the app-boundary ownership model for Fly",
      triggers: [
        { type: "context" as const, value: "fly volumes" },
        { type: "context" as const, value: "fly secrets" },
        { type: "context" as const, value: "fly certificates" },
      ],
      parameters: [],
      examples: [
        {
          title: "Machine with a mounted volume",
          input: "Attach a volume to a machine",
          output: "new Volume({ name: \"data\", region: \"iad\", size_gb: 10 });\nnew Machine({ config: new MachineConfig({ mounts: [{ volume: \"data\", path: \"/data\" }] }) })",
        },
      ],
    },
    {
      file: "chant-fly-ops.md",
      name: "chant-fly-ops",
      description: "Operate a live Fly deploy — wait on stuck machines, resolve lease conflicts, prune safely, and target a real org versus the emulator",
      triggers: [
        { type: "context" as const, value: "fly apply" },
        { type: "context" as const, value: "fly prune" },
        { type: "context" as const, value: "flaps lease" },
      ],
      parameters: [],
      examples: [
        {
          title: "Deploy to a real Fly org",
          input: "Point the same code at a real org",
          output: "export FLY_API_TOKEN=... && chant run fly",
        },
      ],
    },
  ]),

  mcpTools() {
    return []; // TODO: Implement MCP tools
  },

  mcpResources() {
    return []; // TODO: Implement MCP resources
  },

  detectTemplate(data: unknown) {
    return false; // TODO: Detect if a template belongs to this lexicon
  },

  completionProvider(ctx: CompletionContext) {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext) {
    return hover(ctx);
  },

  async docs(options?) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
