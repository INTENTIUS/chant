import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { McpResourceContribution } from "@intentius/chant/mcp/types";
import { createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { otelSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { otelAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { detectTemplate } from "./detect";
import { otelSkills } from "./skill-defs";
import { BUILTIN_CATALOG } from "./catalog";
import { COLLECTOR_PIN } from "./define";

const catalogResource: McpResourceContribution = {
  uri: "otel:resource-catalog",
  name: "OpenTelemetry Collector component catalog",
  description: "The collector components, pipelines and service block this lexicon types, with the collector release they follow",
  mimeType: "application/json",
  async handler(): Promise<string> {
    return JSON.stringify({ pin: COLLECTOR_PIN, entities: BUILTIN_CATALOG });
  },
};

/**
 * OpenTelemetry Collector lexicon plugin.
 *
 * Typed receivers, processors, exporters and extensions, pipelines and the
 * service block, serialized to one collector config file. A component chant
 * doesn't ship comes in through `defineComponent`, and is serialized and
 * checked the same way as the built-ins.
 */
export const otelPlugin: LexiconPlugin = {
  name: "otel",
  serializer: otelSerializer,

  // ── Required lifecycle methods ────────────────────────────────

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    writeGeneratedFiles(await generate(options));
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    printValidationResult(await validate());
  },

  async coverage(_options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const components = BUILTIN_CATALOG.filter((c) => c.type !== undefined);
    const byKind = new Map<string, string[]>();
    for (const c of components) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c.type!]);
    console.error(`otel: ${components.length} built-in components, typed against ${COLLECTOR_PIN.source} ${COLLECTOR_PIN.version}`);
    for (const [kind, types] of byKind) console.error(`  ${kind}s: ${types.join(", ")}`);
    console.error("  anything else: defineComponent (see docs: custom components)");
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { spec, stats } = await packageLexicon(options);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeBundleSpec(spec, join(pkgDir, "dist"));
    console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  // ── Optional extensions ────────────────────────────────────

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return otelAuditCatalog;
  },

  skills: otelSkills,

  mcpTools() {
    return [createDiffTool(otelSerializer, "Compare current collector config output against the previous build", "otel")];
  },

  mcpResources() {
    return [catalogResource];
  },

  detectTemplate(data: unknown) {
    return detectTemplate(data);
  },

  completionProvider(ctx: CompletionContext) {
    return completions(ctx);
  },

  hoverProvider(ctx: HoverContext) {
    return hover(ctx);
  },

  async docs(options?: { verbose?: boolean }) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
