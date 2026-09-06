import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { Declarable } from "@intentius/chant/declarable";
import { terraformSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { terraformAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { terraformConfigSchema, type TerraformConfig } from "./config";
import { renderTerraformRoots } from "./hcl/roots";
import { parseTerraformRootContent } from "./hcl/parse";
import { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";

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
   * Terraform's ownership channel is the state file, not a tag or a label
   * (#2087). Every address `terraform show -json` returns is `owned`;
   * everything else is `unknown`. Declaring the channel is what makes that a
   * claim the conformance suite checks rather than a silent degradation —
   * see `./describe-resources.ts` and `docs/pages/observation.mdx`.
   */
  ownershipChannel: {
    keys: TERRAFORM_STATE_OWNERSHIP_KEYS,
    reads: ["describeResources"],
  },

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

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

  auditCatalog() {
    return terraformAuditCatalog;
  },

  /**
   * Parse-to-graph for `chant audit` (#1567, #2085). `content` is the
   * `# file: <name>`-joined bundle discovery builds for one discovered root
   * module (`classifyTerraform`, `packages/core/src/audit/core.ts`); the root
   * name itself isn't threaded through this hook's single-argument contract,
   * so a fixed placeholder ("audit-root") stands in for it. TF001 only uses
   * the root name to group and de-duplicate diagnostics within one parse, so
   * this is enough for the same graph-reading check that fires on `chant
   * build` to fire here too. Never throws: malformed HCL yields an empty map.
   */
  async auditEntities(content: string): Promise<Map<string, Declarable>> {
    try {
      return await parseTerraformRootContent(content, "audit-root");
    } catch {
      return new Map();
    }
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
