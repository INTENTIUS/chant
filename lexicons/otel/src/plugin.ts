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
import { OtelCollectorParser } from "./import/parser";
import { OtelCollectorGenerator } from "./import/generator";
import { collectorConfigImporter } from "./import/embedded";
import { otelSkills } from "./skill-defs";
import { BUILTIN_CATALOG } from "./catalog";
import { compositeCatalog } from "./composites/catalog";
import { DEFAULT_TEMPLATE, GENAI_TEMPLATE, K8S_AGENT_TEMPLATE } from "./init-templates";
import { COLLECTOR_PIN } from "./define";
import { collectorTopologyOf } from "./topology";

/** opentelemetry-collector-releases also tags its tools (`cmd/builder/v0.163.2`); only the plain release tags are distributions. */
function releaseTag(tag: string): string | null {
  return /^v\d+\.\d+\.\d+$/.test(tag) ? tag : null;
}

const SNAPSHOT_MOVES =
  "The schema snapshot and its digest move with the version: set the version in src/spec/pin.ts, run `just snapshot` " +
  "(lexicons/otel) on a networked machine, paste the printed OTEL_SPEC_PIN into src/spec/pin.ts, run `npm run generate`, " +
  "and read the diffs of src/spec/otel-schemas.snapshot.json and the generated types. Moving otelcol-contrib also moves " +
  "COLLECTOR_PIN and COLLECTOR_IMAGE, the default image of the k8s, docker and fly collector composites, so it is a " +
  "level-0 change that needs an entry on the exceptions list (#2525).";

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
 * Typed receivers, processors, exporters, connectors and extensions, pipelines and the
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

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { coverageReport, formatCoverage } = await import("./coverage");
    const report = coverageReport();
    console.error(formatCoverage(report));
    if (options?.verbose) {
      for (const d of report.distributions) {
        console.error(`  ${d.distribution}, reached through defineComponent: ${[...d.schemaNotBuiltin, ...d.noSchemaNotBuiltin].join(", ")}`);
      }
    }
    console.error("  anything else: defineComponent (see docs: custom components)");
  },

  // #3361: coverage against the otelcol-contrib manifest, offline from the
  // committed schema snapshot.
  async coverageReport(): Promise<{ unaccountedKinds?: string[] }> {
    const { coverageReport } = await import("./coverage");
    return coverageReport();
  },

  // The distribution manifests the generated config types are scoped by
  // (#3361): otelcol-contrib, which COLLECTOR_PIN and COLLECTOR_IMAGE follow,
  // and otelcol-k8s for the coverage report.
  upstreamPin: {
    label: "otelcol-contrib",
    file: "src/spec/pin.ts",
    pattern: /export const OTELCOL_CONTRIB_VERSION = "([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${v}"`),
    alsoMoves: SNAPSHOT_MOVES,
    upstream: { owner: "open-telemetry", repo: "opentelemetry-collector-releases", kind: "releases", tagVersion: releaseTag },
  },
  upstreamPins: [
    {
      label: "otelcol-k8s",
      file: "src/spec/pin.ts",
      pattern: /export const OTELCOL_K8S_VERSION = "([^"]+)"/,
      replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${v}"`),
      alsoMoves: SNAPSHOT_MOVES,
      upstream: { owner: "open-telemetry", repo: "opentelemetry-collector-releases", kind: "releases", tagVersion: releaseTag },
    },
  ],

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

  // Where this project's telemetry goes, for `chant workspace graph` (#2559).
  // A project with no collector pipeline and no component reports nothing.
  graphMeta(entities) {
    const topology = collectorTopologyOf(entities.values());
    if (topology.pipelines.length === 0 && topology.components.length === 0) return undefined;
    return { collector: topology };
  },

  postSynthChecks() {
    return postSynthChecks;
  },

  auditCatalog() {
    return otelAuditCatalog;
  },

  skills: otelSkills,

  composites() {
    return compositeCatalog;
  },

  mcpTools() {
    return [createDiffTool(otelSerializer, "Compare current collector config output against the previous build", "otel")];
  },

  mcpResources() {
    return [catalogResource];
  },

  // `chant init --lexicon otel [--template k8s-agent|genai]`; see ./init-templates.ts.
  initTemplates(template?: string) {
    if (template === "k8s-agent") return K8S_AGENT_TEMPLATE;
    if (template === "genai") return GENAI_TEMPLATE;
    return DEFAULT_TEMPLATE;
  },

  detectTemplate(data: unknown) {
    return detectTemplate(data);
  },

  templateParser() {
    return new OtelCollectorParser();
  },

  templateGenerator() {
    return new OtelCollectorGenerator();
  },

  embeddedImporters() {
    return [collectorConfigImporter];
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
