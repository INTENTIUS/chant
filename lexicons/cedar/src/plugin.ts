import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import { cedarSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks as cedarPostSynthChecks } from "./lint/post-synth";
import { cedarAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { cedarConfigSchema } from "./config";

/**
 * cedar lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const cedarPlugin: LexiconPlugin = {
  name: "cedar",
  serializer: cedarSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    // Cedar's codegen input is the project's own schema, so the `cedar` config
    // namespace is read here rather than being decoration (#1650).
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { loadCedarConfig } = await import("./config");
    const projectRoot = process.cwd();
    const result = await generate({ ...options, projectRoot, config: await loadCedarConfig(projectRoot) });
    writeGeneratedFiles(result);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeCedarCoverage } = await import("./coverage");
    const { loadCedarConfig } = await import("./config");
    const projectRoot = process.cwd();
    analyzeCedarCoverage({
      projectRoot,
      config: await loadCedarConfig(projectRoot),
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
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
    // Auto-discovered from lint/post-synth/ and committed as a static barrel
    // by `npm run generate:barrels` — adding a check is dropping a file.
    return cedarPostSynthChecks;
  },

  auditCatalog() {
    return cedarAuditCatalog;
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

  /** The shape of the `cedar` key in `chant.config.ts` — see ./config.ts. */
  configSchema: cedarConfigSchema,

  /**
   * The pinned upstream is the Cedar *grammar*, not a downloaded spec (#1650).
   *
   * `CEDAR_WASM_VERSION` is the package version the self-upgrade tooling bumps;
   * `CEDAR_LANG_VERSION` beside it is the language version `generate()` asserts
   * at runtime, since a package bump that leaves the language at 4.5 cannot
   * change what parses. Both live in src/spec/pin.ts, which also carries the
   * content pin over the bundled default schema.
   */
  upstreamPin: {
    file: "src/spec/pin.ts",
    pattern: /export const CEDAR_WASM_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${v}"`),
    upstream: { owner: "cedar-policy", repo: "cedar", kind: "releases" as const },
  },
};
