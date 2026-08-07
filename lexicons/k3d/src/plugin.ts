import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { k3dSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { k3dAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * k3d lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const k3dPlugin: LexiconPlugin = {
  name: "k3d",
  serializer: k3dSerializer,

  /**
   * The marker is stamped as Docker labels on every node via
   * `options.runtime.labels` (the serializer does this when a build carries
   * ownership) and read back through `docker inspect` — k3d's own list
   * output does not expose custom labels (#1412, verified live). Labels
   * survive `k3d cluster stop`/`start`.
   */
  ownershipChannel: {
    keys: LABEL_OWNERSHIP_KEYS,
    reads: ["describeResources"],
  },

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

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

  auditCatalog() {
    return k3dAuditCatalog;
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
