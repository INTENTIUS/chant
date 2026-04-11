/**
 * Plugin and index template generators for init-lexicon scaffold.
 */

export function generatePluginTs(name: string, names: { pluginVarName: string; serializerVarName: string }): string {
  return `import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { ${names.serializerVarName} } from "./serializer";
import { rules } from "./lint/rules";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * ${name} lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const ${names.pluginVarName}: LexiconPlugin = {
  name: "${name}",
  serializer: ${names.serializerVarName},

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

    console.error(\`Packaged \${stats.resources} resources, \${stats.ruleCount} rules, \${stats.skillCount} skills\`);
  },

  // ── Optional extensions ────────────────────────────────────

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return []; // TODO: Add post-synth checks
  },

  skills() {
    return []; // TODO: Add skills
  },

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
`;
}

export function generateIndexTs(names: { pluginVarName: string; serializerVarName: string }): string {
  return `// Plugin
export { ${names.pluginVarName} } from "./plugin";

// Serializer
export { ${names.serializerVarName} } from "./serializer";

// Generated resources — export everything from generated index
// After running \`chant generate\`, this re-exports all resource classes
// export * from "./generated/index";
`;
}
