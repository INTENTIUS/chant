import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { OwnershipChannel } from "@intentius/chant/ownership";
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
import { grafanaConfigSchema } from "./config";
import { grafanaDeepNormalizationHooks } from "./deep-observe-hooks";
import { GRAFANA_OWNERSHIP_KEYS } from "./ownership";

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
 * Where chant's marker can be read (#2946, see ./ownership.ts).
 *
 * A dashboard read over `/apis/dashboard.grafana.app` resolves `owned` or
 * `foreign` on all three paths: from chant's managed-by label (stack and env
 * included) when it was written through the API, or from the manager
 * annotation Grafana writes on a dashboard one of the project's providers
 * loaded. What resolves nothing, and says `unknown`, is kind- and
 * server-shaped rather than path-shaped: datasources (their API has no
 * labels) and dashboards on Grafana 11 (read over `/api/dashboards/uid`).
 * An `owned: true` read withholds those as `filtered`.
 */
const ownershipChannel: OwnershipChannel = {
  keys: GRAFANA_OWNERSHIP_KEYS,
  reads: ["describeResources", "observeResourcesDeep", "exportResources"],
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
  configSchema: grafanaConfigSchema,
  ownershipChannel,

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

  // ── Live observation and export (#2946) ──────────────────────
  // Behind dynamic imports, so `chant build` never loads a transport. The
  // hooks are static: core normalizes the declared tree with them whether or
  // not a live read happens.

  async describeResources(options) {
    const { describeResources } = await import("./describe-resources");
    return describeResources(options);
  },

  async observeResourcesDeep(options) {
    const { observeResourcesDeepGrafana } = await import("./deep-observe");
    return observeResourcesDeepGrafana(options);
  },

  deepNormalizationHooks: grafanaDeepNormalizationHooks,

  async exportResources(options) {
    const { exportResources } = await import("./export-resources");
    return exportResources(options);
  },

  async docs(options?: { verbose?: boolean }) {
    const { generateDocs } = await import("./codegen/docs");
    return generateDocs(options);
  },
};
