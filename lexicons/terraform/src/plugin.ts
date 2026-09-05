import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { Declarable } from "@intentius/chant/declarable";
import { terraformSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { terraformConfigSchema, type TerraformConfig } from "./config";
import { renderTerraformRoots } from "./hcl/roots";

/**
 * terraform lexicon plugin.
 *
 * There is no upstream schema to pin here: Terraform's resource surface lives
 * in provider registries, one schema per provider, and this lexicon reads the
 * HCL an estate already has rather than generating types for it. So `spec/`
 * and `codegen/` stay near-empty and there is no `upstreamPin`.
 */
export const terraformPlugin: LexiconPlugin = {
  name: "terraform",
  serializer: terraformSerializer,
  configSchema: terraformConfigSchema,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate } = await import("./codegen/generate");
    await generate(options);
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(_options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    // No upstream spec to measure against. See the note on the plugin.
    console.error("Coverage analysis not applicable: this lexicon generates no types from an upstream spec");
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

  /**
   * Each entry in `terraform.roots` is a root module directory that parses at
   * build time into one entity per HCL block. The render lives in
   * `./hcl/roots.ts`; this member only reads the namespace and hands over the
   * project root, which is what relative `dir` paths resolve against.
   */
  async buildRoots(ctx): Promise<{ entities: Map<string, Declarable>; warnings: string[] }> {
    const roots = (ctx.config as { terraform?: TerraformConfig }).terraform?.roots ?? {};
    if (Object.keys(roots).length === 0) return { entities: new Map(), warnings: [] };
    return renderTerraformRoots({ projectRoot: ctx.projectRoot, roots });
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
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

  detectTemplate(_data: unknown) {
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
