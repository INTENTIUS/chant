import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import type { McpResourceContribution } from "@intentius/chant/mcp/types";
import { createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { prometheusSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks } from "./lint/post-synth";
import { OPT_IN_CHECKS, prometheusAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { detectTemplate } from "./detect";
import { PrometheusParser } from "./import/parser";
import { PrometheusGenerator } from "./import/generator";
import { alertmanagerImporter, ruleGroupsImporter } from "./import/embedded";
import { DEFAULT_TEMPLATE, RULES_TEMPLATE, SLO_STYLE_TEMPLATE, SLO_TEMPLATE } from "./init-templates";
import { prometheusSkills } from "./skill-defs";
import { CATALOG } from "./catalog";
import { PROMETHEUS_PIN } from "./pin";
import { PROMQL_GRAMMAR } from "./promql";
import { compositeCatalog } from "./composites/catalog";

const catalogResource: McpResourceContribution = {
  uri: "prometheus:resource-catalog",
  name: "Prometheus entity catalog",
  description: "The rule group and Alertmanager entities this lexicon types, with the Prometheus and Alertmanager releases they follow",
  mimeType: "application/json",
  async handler(): Promise<string> {
    return JSON.stringify({ pin: PROMETHEUS_PIN, promql: PROMQL_GRAMMAR, entities: CATALOG });
  },
};

/**
 * Prometheus lexicon plugin.
 *
 * Typed recording and alerting rule groups, serialized to a Prometheus rule
 * file, and Alertmanager routes, receivers, inhibit rules and time
 * intervals, serialized to `alertmanager.yml`.
 */
export const prometheusPlugin: LexiconPlugin = {
  name: "prometheus",
  serializer: prometheusSerializer,

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
    const { prometheus, alertmanager } = PROMETHEUS_PIN;
    console.error(`prometheus: ${CATALOG.length} entities`);
    console.error(`  rule file (${prometheus.source} ${prometheus.version}): RuleGroup, recording and alerting rules`);
    console.error(
      `  alertmanager.yml (${alertmanager.source} ${alertmanager.version}): ` +
        CATALOG.filter((c) => c.file === "alertmanager.yml").map((c) => c.className).join(", "),
    );
    console.error("  receivers typed: webhook, email, slack, pagerduty");
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
    return prometheusAuditCatalog;
  },

  /**
   * `recommended` (what `chant build` reports by default) is every check but
   * the opt-in ones; `all` adds them. A project turns one on with
   * `lint.presets: { prometheus: "all" }`, or by naming it in `lint.rules`
   * (`{ PROM212: "warning" }`), which keeps a check whatever the preset.
   */
  lintPresets() {
    const all = Object.keys(prometheusAuditCatalog);
    return { recommended: all.filter((id) => !OPT_IN_CHECKS.has(id)), all };
  },

  skills: prometheusSkills,

  composites() {
    return compositeCatalog;
  },

  mcpTools() {
    return [
      createDiffTool(
        prometheusSerializer,
        "Compare the current rule file and alertmanager.yml output against the previous build",
        "prometheus",
      ),
    ];
  },

  mcpResources() {
    return [catalogResource];
  },

  detectTemplate(data: unknown) {
    return detectTemplate(data);
  },

  templateParser() {
    return new PrometheusParser();
  },

  templateGenerator() {
    return new PrometheusGenerator();
  },

  embeddedImporters() {
    return [ruleGroupsImporter, alertmanagerImporter];
  },

  // `chant init --lexicon prometheus [--template rules|slo-style|slo]`; see ./init-templates.ts.
  initTemplates(template?: string) {
    if (template === "rules") return RULES_TEMPLATE;
    if (template === "slo-style") return SLO_STYLE_TEMPLATE;
    if (template === "slo") return SLO_TEMPLATE;
    return DEFAULT_TEMPLATE;
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
