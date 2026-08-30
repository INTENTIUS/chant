import type { LexiconPlugin, SkillDefinition, IntrinsicDef } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import {
  createSkillsLoader,
  createDiffTool,
  createCatalogResource,
} from "@intentius/chant/lexicon-plugin-helpers";
import { fountainSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { fountainAuditCatalog } from "./lint/audit-catalog";
import { fountainAuditEntities } from "./audit-entities";
import { fountainReferenceCatalog } from "./reference-catalog";
import { detectFountainTemplate } from "./detect";
import { fountainInitTemplates } from "./init-templates";
import { FountainParser } from "./import/parser";
import { FountainGenerator } from "./import/generator";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * fountain lexicon plugin.
 *
 * Implements all required LexiconPlugin lifecycle methods.
 */
export const fountainPlugin: LexiconPlugin = {
  name: "fountain",
  serializer: fountainSerializer,

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
    const { analyzeFountainCoverage } = await import("./coverage");
    await analyzeFountainCoverage(options);
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

  // #1330 — the fact check-lexicon gates on, computed offline from the
  // committed spec snapshot + surface baseline. Never fetchSchemas():
  // check-lexicon runs per-PR, no network.
  async coverageReport(): Promise<{ unaccountedKinds?: string[] }> {
    const { coverageReportFromSnapshots } = await import("./coverage");
    return { unaccountedKinds: coverageReportFromSnapshots().unaccountedKinds };
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog: () => fountainAuditCatalog,

  auditEntities(content: string) {
    return fountainAuditEntities(content);
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-fountain.md",
      name: "chant-fountain",
      description:
        "Declare, lint, and reconcile fountain Environments, Vaults, and Agents from a chant project",
      triggers: [
        { type: "context" as const, value: "fountain" },
        { type: "context" as const, value: "fountain.inevitable.fyi" },
      ],
    },
    {
      file: "chant-fountain-secrets.md",
      name: "chant-fountain-secrets",
      description: "Handle fountain secrets, env vars, and ${VAR} substitution safely from chant",
      triggers: [
        { type: "context" as const, value: "fountain secrets" },
        { type: "context" as const, value: "vault" },
      ],
    },
    {
      file: "chant-fountain-locked-sandboxes.md",
      name: "chant-fountain-locked-sandboxes",
      description:
        "Declare locked-down fountain environments for untrusted agents and run conversations against them",
      triggers: [
        { type: "context" as const, value: "sandbox" },
        { type: "context" as const, value: "networking_type" },
      ],
    },
  ]),

  mcpTools(): McpToolContribution[] {
    return [
      createDiffTool(
        fountainSerializer,
        "Compare current fountain build output (fountain manifest YAML) against previous version",
        "fountain",
      ),
    ];
  },

  mcpResources(): McpResourceContribution[] {
    return [
      createCatalogResource(
        import.meta.url,
        "Fountain Resource Types",
        "The three fountain workload kinds declarable from chant: Environment, Vault, Agent (conversations are runs, started by the fountainRun op)",
        "lexicon-fountain.json",
        "fountain",
      ),
    ];
  },

  initTemplates(template?: string) {
    return fountainInitTemplates(template);
  },

  detectTemplate(data: unknown) {
    return detectFountainTemplate(data);
  },

  templateParser() {
    return new FountainParser();
  },

  templateGenerator() {
    return new FountainGenerator();
  },

  async exportResources(options) {
    const { exportResources } = await import("./export-resources");
    return exportResources(options);
  },

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

  referenceCatalog: fountainReferenceCatalog,

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
