/**
 * The sql lexicon plugin.
 *
 * One lexicon, a subpath per database dialect (#3047, "Packaging"); ClickHouse
 * is the first, at `@intentius/chant-lexicon-sql/clickhouse`. Generation reads
 * the pinned ClickHouse server's catalog (src/spec/), and the rest of the
 * plugin is the shared machinery every dialect plugs into.
 */

import type { IntrinsicDef, LexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";
import { sqlSerializer } from "./serializer";
import { rules } from "./lint/rules";
import { postSynthChecks as postSynthCheckList } from "./lint/post-synth";
import { sqlAuditCatalog } from "./lint/audit-catalog";
import { completions } from "./lsp/completions";
import { hover } from "./lsp/hover";
import { sqlMcpResources, sqlMcpTools } from "./mcp";
import { sqlConfigSchema } from "./config";
import { ClickHouseSqlParser } from "./clickhouse/import/parser";
import { ClickHouseGenerator } from "./clickhouse/import/generator";
import { sqlCommands } from "./clickhouse/plan/commands";
import { sqlDeepNormalizationHooks } from "./clickhouse/plan/deep";
import { versionFromReleaseTag } from "./spec/pin";
import { SQL_OWNERSHIP_CHANNEL } from "./clickhouse/ownership";
import { CLICKHOUSE_EMULATOR } from "./op/activities/clickhouse-emulator";
import { sqlSkills } from "./skill-defs";
import { detectTemplate } from "./detect";
import { CDC_TEMPLATE, DEFAULT_TEMPLATE, EVENTS_TEMPLATE } from "./init-templates";
import { compositeCatalog } from "./composites/catalog";

export const sqlPlugin: LexiconPlugin = {
  name: "sql",
  serializer: sqlSerializer,
  configSchema: sqlConfigSchema,

  /** The pinned clickhouse-server, for `chant emulator up` (#3208). */
  emulator: CLICKHOUSE_EMULATOR,

  /** chant's marker is a trailer on the object's comment (#3208, ./clickhouse/ownership.ts). */
  ownershipChannel: SQL_OWNERSHIP_CHANNEL,

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
    const { analyze, printCoverage } = await import("./coverage");
    printCoverage(analyze(), options);
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { spec, stats } = await packageLexicon(options);
    writeBundleSpec(spec, join(dirname(dirname(fileURLToPath(import.meta.url))), "dist"));
    console.error(`Packaged ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  lintRules() {
    return rules;
  },

  postSynthChecks() {
    return postSynthCheckList;
  },

  auditCatalog() {
    return sqlAuditCatalog;
  },

  /**
   * The ClickHouse tags fold: `chant build` reduces a `table`, `view` or
   * `database` template to the entity the tag builds, without running the
   * file. `literal(...)` folds as a call so it can sit inside a tag.
   */
  intrinsics(): IntrinsicDef[] {
    return [
      { name: "database", isTag: true, description: "A ClickHouse CREATE DATABASE, parsed into a database entity" },
      { name: "table", isTag: true, description: "A ClickHouse CREATE TABLE, parsed into a table entity" },
      {
        name: "view",
        isTag: true,
        description: "A ClickHouse CREATE VIEW or CREATE MATERIALIZED VIEW, parsed into a view entity with its lineage",
      },
      {
        name: "literal",
        isTag: false,
        foldsAsCall: true,
        description: "A quoted, escaped SQL string literal, for a string interpolated as a value rather than as SQL text",
      },
    ];
  },

  skills: sqlSkills,

  /** The ClickHouse composites (./composites), as the catalog generated from their exports. */
  composites() {
    return compositeCatalog;
  },

  // `chant init --lexicon sql [--template events|cdc]`; see ./init-templates.ts.
  initTemplates(template?: string) {
    if (template === "events") return EVENTS_TEMPLATE;
    if (template === "cdc") return CDC_TEMPLATE;
    return DEFAULT_TEMPLATE;
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

  mcpTools() {
    return sqlMcpTools();
  },

  mcpResources() {
    return sqlMcpResources();
  },

  /** `chant import schema.sql`: a file of ClickHouse CREATE statements. */
  templateParser() {
    return new ClickHouseSqlParser();
  },

  templateGenerator() {
    return new ClickHouseGenerator();
  },

  /** Which declared objects exist on the environment's server (`sql.profiles.<env>`, else `CLICKHOUSE_URL`). */
  async describeResources(options) {
    const { describeResources } = await import("./clickhouse/live/describe-resources");
    return describeResources(options);
  },

  /** `chant import --from <env>`: the server's schema, from `SHOW CREATE`, as declarations. */
  async exportResources(options) {
    const { exportResources } = await import("./clickhouse/import/live-export");
    return exportResources(options);
  },

  /** Each declared object's live definition, in the declaration's own shape. */
  async observeResourcesDeep(options) {
    const { observeResourcesDeep } = await import("./clickhouse/plan/deep");
    return observeResourcesDeep(options);
  },

  deepNormalizationHooks: sqlDeepNormalizationHooks,

  /** What an update costs: metadata in-place, a background rewrite rolling, a rebuild replace. */
  async classifyDisruption(options) {
    const { classifyDisruption } = await import("./clickhouse/plan/disruption");
    return classifyDisruption(options);
  },

  /** `chant sql diff` and `chant sql plan`: schema changes, classified. */
  commands() {
    return sqlCommands;
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  /**
   * The pin is a ClickHouse LTS release. GitHub tags them `v26.8.15.10-lts`;
   * the constant holds `26.8.15.10`, which is also the docker tag. A move also
   * needs `CLICKHOUSE_IMAGE_DIGEST` updated: generation refuses a server whose
   * version is not the pin.
   */
  upstreamPin: {
    file: "src/spec/pin.ts",
    pattern: /export const CLICKHOUSE_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${versionFromReleaseTag(v)}"`),
    alsoMoves:
      "CLICKHOUSE_IMAGE_DIGEST in src/spec/pin.ts moves with the version: set CLICKHOUSE_VERSION to the new release, set the digest to that tag's image digest (docker buildx imagetools inspect clickhouse/clickhouse-server:<version>), then run `chant dev generate` and read the diff of src/spec/clickhouse-catalog.snapshot.json.",
    upstream: { owner: "ClickHouse", repo: "ClickHouse", kind: "releases", tagSuffix: "-lts" },
  },
};
