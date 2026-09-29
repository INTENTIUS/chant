import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { McpResourceContribution } from "@intentius/chant/mcp/types";
import { createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { grafanaSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { grafanaAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { detectTemplate } from "./detect";
import { GrafanaParser } from "./import/parser";
import { GrafanaGenerator } from "./import/generator";
import { grafanaSkills } from "./skill-defs";
import { BUILTIN_CATALOG } from "./catalog";
import { GRAFANA_SCHEMA_PIN } from "./pin";
import { compositeCatalog } from "./composites/catalog";

const catalogResource: McpResourceContribution = {
  uri: "grafana:resource-catalog",
  name: "Grafana entity catalog",
  description: "The dashboard, datasource, panel, query and variable classes this lexicon types, with the Grafana schema pin they follow",
  mimeType: "application/json",
  async handler(): Promise<string> {
    return JSON.stringify({ pin: GRAFANA_SCHEMA_PIN, entities: BUILTIN_CATALOG });
  },
};

/**
 * Grafana lexicon plugin.
 *
 * Dashboards, panels, typed Prometheus, Tempo and Loki queries, variables
 * and datasources, serialized to dashboard JSON and Grafana's provisioning
 * files. Panel options and query models are generated from Grafana's own
 * schemas at `GRAFANA_SCHEMA_PIN`; `definePanel` and `defineQuery` add
 * plugins chant doesn't ship.
 */
export const grafanaPlugin: LexiconPlugin = {
  name: "grafana",
  serializer: grafanaSerializer,

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
    const byKind = new Map<string, string[]>();
    for (const c of BUILTIN_CATALOG) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c.pluginId ?? c.className]);
    console.error(`grafana: ${BUILTIN_CATALOG.length} entity classes, typed against ${GRAFANA_SCHEMA_PIN.source} ${GRAFANA_SCHEMA_PIN.ref}`);
    for (const [kind, names] of byKind) console.error(`  ${kind}: ${names.join(", ")}`);
    console.error("  other panel and datasource plugins: definePanel, defineQuery");
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

  // Panels, rows, queries and variables live inside a dashboard, so core
  // lint does not count them as resources (chant #2957).
  propertyClassNames() {
    return BUILTIN_CATALOG.filter((e) => e.entityKind === "property").map((e) => e.className);
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return grafanaAuditCatalog;
  },

  skills: grafanaSkills,

  composites() {
    return compositeCatalog;
  },

  mcpTools() {
    return [createDiffTool(grafanaSerializer, "Compare current Grafana dashboard and provisioning output against the previous build", "grafana")];
  },

  mcpResources() {
    return [catalogResource];
  },

  detectTemplate(data: unknown) {
    return detectTemplate(data);
  },

  templateParser() {
    return new GrafanaParser();
  },

  templateGenerator() {
    return new GrafanaGenerator();
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
