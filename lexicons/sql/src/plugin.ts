/**
 * The sql lexicon plugin.
 *
 * One lexicon, a subpath per database dialect (#3047, "Packaging"): ClickHouse
 * at `@intentius/chant-lexicon-sql/clickhouse`, Postgres at
 * `@intentius/chant-lexicon-sql/postgres` (#3289). Generation reads
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
import { SqlFileParser, dialectOption } from "./import-parser";
import { sqlTemplateGenerator } from "./import-generator";
import { sqlCommands } from "./clickhouse/plan/commands";
import { sqlDeepNormalizationHooks } from "./clickhouse/plan/deep";
import { versionFromReleaseTag } from "./spec/pin";
import { POSTGRES_MAJORS, postgresUpstreamPin } from "./spec/postgres-pin";
import { SQL_OWNERSHIP_CHANNEL } from "./clickhouse/ownership";
import { CLICKHOUSE_EMULATOR } from "./op/activities/clickhouse-emulator";
import { POSTGRES_EMULATOR } from "./op/activities/postgres-emulator";
import { sqlSkills } from "./skill-defs";
import { detectTemplate } from "./detect";
import { CDC_TEMPLATE, DEFAULT_TEMPLATE, EVENTS_TEMPLATE, POSTGRES_EVENTS_TEMPLATE, POSTGRES_TEMPLATE, POSTGRES_TENANT_TEMPLATE } from "./init-templates";
import { compositeCatalog } from "./composites/catalog";

export const sqlPlugin: LexiconPlugin = {
  name: "sql",
  serializer: sqlSerializer,
  configSchema: sqlConfigSchema,

  /** The pinned clickhouse-server (#3208) and postgres (#3280), for `chant emulator up`. */
  emulator: [CLICKHOUSE_EMULATOR, POSTGRES_EMULATOR],

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
   * The tags fold: `chant build` reduces a `table`, `view` or other template
   * to the entity the tag builds, without running the file. An intrinsic is
   * registered by name and folds as the function the file imports, so
   * `table` from `/clickhouse` and `table` from `/postgres` are each their
   * own dialect's. `literal(...)` folds as a call so it can sit inside a tag.
   */
  intrinsics(): IntrinsicDef[] {
    return [
      { name: "database", isTag: true, description: "A ClickHouse CREATE DATABASE, parsed into a database entity" },
      { name: "table", isTag: true, description: "A ClickHouse or Postgres CREATE TABLE, parsed into a table entity" },
      {
        name: "view",
        isTag: true,
        description: "A CREATE VIEW or CREATE MATERIALIZED VIEW, parsed into a view entity with its lineage",
      },
      { name: "dictionary", isTag: true, description: "A ClickHouse CREATE DICTIONARY, parsed into a dictionary entity with its attributes, key, source and layout" },
      { name: "schema", isTag: true, description: "A Postgres CREATE SCHEMA, parsed into a schema entity" },
      { name: "index", isTag: true, description: "A Postgres CREATE INDEX, parsed into an index entity" },
      { name: "sequence", isTag: true, description: "A Postgres CREATE SEQUENCE, parsed into a sequence entity" },
      { name: "type", isTag: true, description: "A Postgres CREATE TYPE ... AS ENUM, parsed into an enum entity" },
      { name: "domain", isTag: true, description: "A Postgres CREATE DOMAIN, parsed into a domain entity" },
      { name: "extension", isTag: true, description: "A Postgres CREATE EXTENSION, parsed into an extension entity" },
      { name: "func", isTag: true, description: "A Postgres CREATE FUNCTION, parsed into a function entity with its body kept verbatim, or a ClickHouse CREATE FUNCTION (a named lambda)" },
      { name: "procedure", isTag: true, description: "A Postgres CREATE PROCEDURE, parsed into a procedure entity with its body kept verbatim" },
      { name: "trigger", isTag: true, description: "A Postgres CREATE TRIGGER, parsed into a trigger entity on its table" },
      { name: "policy", isTag: true, description: "A Postgres CREATE POLICY, parsed into a row-level security policy on its table" },
      { name: "role", isTag: true, description: "A Postgres CREATE ROLE without a password or memberships, parsed into a role entity" },
      { name: "grant", isTag: true, description: "A Postgres GRANT, REVOKE or ALTER DEFAULT PRIVILEGES, parsed into the privileges it declares" },
      {
        name: "literal",
        isTag: false,
        foldsAsCall: true,
        description: "A quoted, escaped SQL string literal, for a string interpolated as a value rather than as SQL text",
      },
    ];
  },

  skills: sqlSkills,

  /** The ClickHouse and Postgres composites (./composites), as the catalog generated from their exports. */
  composites() {
    return compositeCatalog;
  },

  // `chant init --lexicon sql [--template events|cdc|postgres|postgres-tenant|postgres-events]`; see ./init-templates.ts.
  initTemplates(template?: string) {
    if (template === "events") return EVENTS_TEMPLATE;
    if (template === "cdc") return CDC_TEMPLATE;
    if (template === "postgres") return POSTGRES_TEMPLATE;
    if (template === "postgres-tenant") return POSTGRES_TENANT_TEMPLATE;
    if (template === "postgres-events") return POSTGRES_EVENTS_TEMPLATE;
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

  /** `chant import schema.sql`: a file of Postgres or ClickHouse DDL (`./import-parser.ts`). */
  templateParser(options) {
    return new SqlFileParser(dialectOption(options));
  },

  parserOptions() {
    return [
      {
        name: "dialect",
        type: "string" as const,
        description: "the DDL's dialect, clickhouse or postgres; read off its statements when omitted",
      },
    ];
  },

  /**
   * The `.sql` files in the source directory, read into declarations beside
   * the tagged templates (`./files/build-root.ts`, #3646).
   */
  async buildRoots(ctx) {
    const { sqlFilesBuildRoot } = await import("./files/build-root");
    return sqlFilesBuildRoot(ctx);
  },

  /** One generator for both dialects: each IR resource's type says whose declarations it is. */
  templateGenerator() {
    return sqlTemplateGenerator;
  },

  /**
   * Which declared objects exist on the environment's server
   * (`sql.profiles.<env>`, else `CLICKHOUSE_URL` or `POSTGRES_URL`). The
   * declarations' dialect picks the reader; node-postgres loads only for a
   * Postgres one.
   */
  async describeResources(options) {
    const { dialectOfEntities } = await import("./live-dialect");
    if (dialectOfEntities(options.entities) === "postgres") {
      const { describeResources } = await import("./postgres/live/describe-resources");
      return describeResources(options);
    }
    const { describeResources } = await import("./clickhouse/live/describe-resources");
    return describeResources(options);
  },

  /** `chant import --from <env>`: the server's schema as declarations, from `SHOW CREATE` or the Postgres catalog's printers. */
  async exportResources(options) {
    const { resolveBindingDialect } = await import("./live-dialect");
    if ((await resolveBindingDialect(options)) === "postgres") {
      const { exportResources } = await import("./postgres/import/live-export");
      return exportResources(options);
    }
    const { exportResources } = await import("./clickhouse/import/live-export");
    return exportResources(options);
  },

  /** Each declared object's live definition, in the declaration's own shape. */
  async observeResourcesDeep(options) {
    const { dialectOfEntities } = await import("./live-dialect");
    if (dialectOfEntities(options.entities) === "postgres") {
      const { observeResourcesDeep } = await import("./postgres/plan/deep");
      return observeResourcesDeep(options);
    }
    const { observeResourcesDeep } = await import("./clickhouse/plan/deep");
    return observeResourcesDeep(options);
  },

  deepNormalizationHooks: sqlDeepNormalizationHooks,

  /**
   * What an update costs. ClickHouse: metadata in-place, a background rewrite
   * rolling, a rebuild replace. Postgres: metadata in-place, a validation, a
   * CONCURRENTLY build or an ACCESS EXCLUSIVE rewrite rolling, expand and
   * contract replace. Each dialect answers for its own types.
   */
  async classifyDisruption(options) {
    const { classifyDisruption } = await import("./clickhouse/plan/disruption");
    const { classifyPgDisruption } = await import("./postgres/plan/disruption");
    return { ...classifyDisruption(options), ...classifyPgDisruption(options) };
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
    label: "clickhouse",
    file: "src/spec/pin.ts",
    pattern: /export const CLICKHOUSE_VERSION\s*=\s*"([^"]+)"/,
    replace: (v: string, line: string) => line.replace(/= "[^"]+"/, `= "${versionFromReleaseTag(v)}"`),
    alsoMoves:
      "CLICKHOUSE_IMAGE_DIGEST in src/spec/pin.ts moves with the version: set CLICKHOUSE_VERSION to the new release, set the digest to that tag's image digest (docker buildx imagetools inspect clickhouse/clickhouse-server:<version>), then run `chant dev generate` and read the diff of src/spec/clickhouse-catalog.snapshot.json.",
    upstream: { owner: "ClickHouse", repo: "ClickHouse", kind: "releases", tagSuffix: "-lts" },
  },

  /** The Postgres servers, one pin per major (`postgres-14` to `postgres-18`). */
  upstreamPins: POSTGRES_MAJORS.map(postgresUpstreamPin),
};
