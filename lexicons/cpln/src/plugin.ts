import type {
  LexiconPlugin,
  SkillDefinition,
  InitTemplateSet,
  DescribeResourcesResult,
} from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "@intentius/chant/lsp/types";
import type { McpToolContribution, McpResourceContribution } from "@intentius/chant/mcp/types";
import type { OwnershipChannel } from "@intentius/chant/ownership";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { cplnSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { cplnAuditCatalog } from "./lint/audit-catalog";
import { cplnReferenceCatalog } from "./reference-catalog";
import { CPLN_TAG_OWNERSHIP_KEYS } from "./ownership";
import { detectCplnTemplate } from "./detect";
import { cplnInitTemplates } from "./init-templates";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";

/**
 * The cpln lexicon plugin.
 *
 * Control Plane's `tags` map is the ownership channel, and unusually it works
 * on the thin read: every kind carries `tags` and every read path returns
 * them, so `describeResources` resolves a real verdict rather than `unknown`.
 * That is why `describeResources` is declared among the channel's read paths
 * where aws — whose `describe-stack-resources` returns no tags at all — cannot
 * declare it.
 *
 * `observeResourcesDeep` and `exportResources` are not implemented yet, so
 * they are absent from `reads` rather than listed optimistically: the contract
 * is that a declared path resolves a verdict, and claiming one this plugin has
 * no implementation for would be a lie the checker cannot catch.
 */
const ownershipChannel: OwnershipChannel = {
  keys: CPLN_TAG_OWNERSHIP_KEYS,
  reads: ["describeResources"],
};

export const cplnPlugin: LexiconPlugin = {
  name: "cpln",
  serializer: cplnSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const result = await generate(options);
    writeGeneratedFiles(result, dirname(dirname(fileURLToPath(import.meta.url))));
  },

  async validate(): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    printValidationResult(await validate());
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeCplnCoverage } = await import("./coverage");
    await analyzeCplnCoverage(options);
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

  // ── Lint and audit ────────────────────────────────────────────

  lintRules(): LintRule[] {
    return rules;
  },

  postSynthChecks(): PostSynthCheck[] {
    return postSynthChecks;
  },

  auditCatalog: () => cplnAuditCatalog,

  // ── Observation ───────────────────────────────────────────────

  ownershipChannel,

  referenceCatalog: cplnReferenceCatalog,

  async describeResources(options): Promise<DescribeResourcesResult> {
    const { describeResources } = await import("./describe-resources");
    return describeResources({
      environment: options.environment,
      buildOutput: options.buildOutput,
      entityNames: options.entityNames,
      entities: options.entities,
      owned: options.owned,
    });
  },

  // ── Language surface ──────────────────────────────────────────

  completionProvider(ctx: CompletionContext): CompletionItem[] {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext): HoverInfo | undefined {
    return hover(ctx);
  },

  // ── Import and project surface ────────────────────────────────

  detectTemplate(data: unknown): boolean {
    return detectCplnTemplate(data);
  },

  /**
   * The three `chant init` scaffolds, named at the plugin surface so the
   * available set is visible where a reader looks for it rather than only
   * inside the switch that resolves them. An unrecognised name falls through
   * to the default — `chant init` treats it as a hint, not a key.
   */
  initTemplates(template?: string): InitTemplateSet {
    if (template === "secrets") return cplnInitTemplates("secrets");
    if (template === "stateful") return cplnInitTemplates("stateful");
    return cplnInitTemplates();
  },

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-cpln.md",
      name: "chant-cpln",
      description:
        "Declare Control Plane (cpln) infrastructure from chant — the kinds, GVC scoping, links, and what the serializer emits",
    },
    {
      file: "chant-cpln-workloads.md",
      name: "chant-cpln-workloads",
      description:
        "Choose a Control Plane workload type and configure autoscaling, Capacity AI, resources and probes correctly",
    },
    {
      file: "chant-cpln-secrets.md",
      name: "chant-cpln-secrets",
      description:
        "Wire Control Plane secrets, identities and policies so a workload can actually read them",
    },
  ]) as () => SkillDefinition[],

  mcpTools(): McpToolContribution[] {
    return [
      createDiffTool(
        cplnSerializer,
        "Diff the current cpln manifests against the previous build output",
        "cpln",
      ),
    ];
  },

  mcpResources(): McpResourceContribution[] {
    return [
      createCatalogResource(
        import.meta.url,
        "Control Plane Resource Catalog",
        "Every cpln resource and property type, with its Control Plane type name",
        "lexicon-cpln.json",
        "cpln",
      ),
    ];
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
