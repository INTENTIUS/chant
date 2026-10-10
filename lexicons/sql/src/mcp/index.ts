/**
 * MCP contributions for the sql lexicon (chant #3210). Tools answer from the
 * committed ClickHouse catalog and the tag parser, so an agent can look up an
 * engine, a type or a setting, and check a statement, without a server.
 *
 * Tools register as `sql:<verb>` and resources as `chant://sql/<path>`.
 */

import type { McpResourceContribution, McpToolContribution } from "@intentius/chant/mcp/types";
import { createCatalogResource, createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { sqlSerializer } from "../serializer";
import { catalogIndex } from "../lsp/catalog";
import { database, dictionary, func, grant, policy, role, table, user, view } from "../clickhouse/entities";
import { SqlSyntaxError } from "../clickhouse/tokens";
import { existsSync, readFileSync } from "fs";
import { diffSchemas } from "../clickhouse/plan/diff";
import { renderDiff } from "../clickhouse/plan/report";
import { rebuildOpSuggestions } from "../clickhouse/plan/rebuild-handoff";
import { CLASSIFIER_RULES } from "../clickhouse/plan/rules";
import { schemaFromBuildFile, schemaFromBuildOutput } from "../clickhouse/plan/schema";
import { asMajor, POSTGRES_KINDS, POSTGRES_TAGS, postgresLookup, postgresMcpResources, postgresParse, postgresSearch } from "./postgres";
import { diffPgSchemas } from "../postgres/plan/diff";
import { renderPgDiff } from "../postgres/plan/report";
import { PG_CLASSIFIER_RULES } from "../postgres/plan/rules";
import { pgSchemaFromBuildFile, pgSchemaFromBuildOutput } from "../postgres/plan/schema";
import { migrationOpSuggestions } from "../postgres/migrate/handoff";
import { CLICKHOUSE_IMAGE_DIGEST, CLICKHOUSE_VERSION, clickhouseImage } from "../spec/pin";

const KINDS = ["engine", "database-engine", "type", "codec", "index-type", "setting", "function", "format"] as const;
type Kind = (typeof KINDS)[number];

const kindProp = {
  type: "string",
  enum: [...new Set([...KINDS, ...POSTGRES_KINDS])],
  description: `Which part of the catalog. ClickHouse: ${KINDS.join(", ")}. Postgres: ${POSTGRES_KINDS.join(", ")}`,
};
const dialectProp = { type: "string", enum: ["clickhouse", "postgres"], description: "The dialect to answer for (default clickhouse)" };
const majorProp = { type: "number", description: "Postgres only: answer for this major (14 to 18; for classify-change, the server's major); omitted, every major, with since/until on names not in all" };

function asDialect(value: unknown): "clickhouse" | "postgres" {
  if (value === undefined || value === "clickhouse") return "clickhouse";
  if (value === "postgres") return "postgres";
  throw new Error("dialect must be clickhouse or postgres");
}

type Row = { name: string; summary?: string };

function rows(kind: Kind): Row[] {
  const index = catalogIndex();
  if (!index) throw new Error("the ClickHouse catalog snapshot could not be read");
  const { catalog } = index;
  switch (kind) {
    case "engine":
      return catalog.tableEngines;
    case "database-engine":
      return catalog.databaseEngines;
    case "type":
      return catalog.typeFamilies;
    case "codec":
      return catalog.codecs;
    case "index-type":
      return catalog.skipIndexTypes;
    case "setting":
      return [
        ...catalog.mergeTreeSettings.map((s) => ({ ...s, scope: "merge-tree" })),
        ...catalog.querySettings.map((s) => ({ ...s, scope: "query" })),
      ];
    case "function":
      return catalog.functions;
    case "format":
      return catalog.formats;
  }
}

function asKind(value: unknown): Kind {
  if (!KINDS.includes(value as Kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  return value as Kind;
}

const lookupTool: McpToolContribution = {
  name: "lookup",
  description:
    "Look up a catalog entry by name. ClickHouse (default): engine, type family, codec, skip index type, setting, function or format, from the pinned server (" +
    CLICKHOUSE_VERSION +
    "). Postgres (dialect postgres): type or alias, index or table access method, storage parameter, setting, function, key word or extension, from the pinned servers of majors 14 to 18, with since/until. Returns every catalog row with that name, or the closest names when there is none.",
  inputSchema: { type: "object", properties: { dialect: dialectProp, kind: kindProp, name: { type: "string" }, major: majorProp }, required: ["kind", "name"] },
  async handler(params) {
    if (asDialect(params.dialect) === "postgres") return postgresLookup(params);
    const kind = asKind(params.kind);
    const name = String(params.name ?? "");
    const all = rows(kind);
    const exact = all.filter((r) => r.name === name);
    const found = exact.length ? exact : all.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    if (found.length) return { kind, version: CLICKHOUSE_VERSION, matches: found };
    const near = all.filter((r) => r.name.toLowerCase().includes(name.toLowerCase())).slice(0, 10).map((r) => r.name);
    return { kind, version: CLICKHOUSE_VERSION, matches: [], closest: near };
  },
};

const searchTool: McpToolContribution = {
  name: "search",
  description: "Search one part of a dialect's catalog by a name substring. Returns names with the first line of their description.",
  inputSchema: {
    type: "object",
    properties: { dialect: dialectProp, kind: kindProp, query: { type: "string" }, major: majorProp, limit: { type: "number", description: "At most this many results (default 25)" } },
    required: ["kind", "query"],
  },
  async handler(params) {
    if (asDialect(params.dialect) === "postgres") return postgresSearch(params);
    const kind = asKind(params.kind);
    const query = String(params.query ?? "").toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(params.limit ?? 25)));
    const hits = rows(kind).filter((r) => r.name.toLowerCase().includes(query));
    return {
      kind,
      total: hits.length,
      results: hits.slice(0, limit).map((r) => ({ name: r.name, ...(typeof r.summary === "string" ? { summary: r.summary } : {}) })),
    };
  },
};

const parseTool: McpToolContribution = {
  name: "parse-ddl",
  description:
    "Parse one CREATE statement the way its tag does (dialect clickhouse, the default: table, view, database, dictionary, func, user, role, policy, grant; dialect postgres: schema, table, index, view, sequence, type, domain, extension), and return the entity it builds (columns, engine, keys, settings, and for a view its lineage). A statement that does not parse comes back as the error with its line and column, the same one SQLCH001 (ClickHouse) or SQLPG001 (Postgres) reports. The statement is plain DDL: there are no interpolations.",
  inputSchema: {
    type: "object",
    properties: {
      dialect: dialectProp,
      tag: { type: "string", enum: [...new Set(["table", "view", "database", "dictionary", "func", "user", "role", "policy", "grant", ...POSTGRES_TAGS])], description: "The tag the statement belongs in (ClickHouse: table, view, database, dictionary, func, user, role, policy, grant; Postgres: " + POSTGRES_TAGS.join(", ") + ")" },
      ddl: { type: "string", description: "The CREATE statement" },
    },
    required: ["tag", "ddl"],
  },
  async handler(params) {
    const ddl = String(params.ddl ?? "");
    const tag = String(params.tag);
    if (asDialect(params.dialect) === "postgres") return postgresParse(tag, ddl, position);
    const build = tag === "table" ? table : tag === "view" ? view : tag === "database" ? database : tag === "dictionary" ? dictionary : tag === "func" ? func : tag === "user" ? user : tag === "role" ? role : tag === "policy" ? policy : tag === "grant" ? grant : undefined;
    if (!build) throw new Error("tag must be table, view, database, dictionary, func, user, role, policy or grant");
    const strings = Object.assign([ddl], { raw: [ddl] }) as unknown as TemplateStringsArray;
    try {
      const entity = build(strings);
      return { ok: true, entityType: entity.entityType, name: entity.sqlName, props: JSON.parse(JSON.stringify(entity.props)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offset = (err as { offset?: number }).offset;
      const where = typeof offset === "number" ? position(ddl, offset) : undefined;
      const syntax = err instanceof SqlSyntaxError || (err as Error).name === "SqlTemplateError";
      return { ok: false, rule: syntax ? "SQLCH001" : undefined, message, ...(where ?? {}) };
    }
  },
};

const classifyTool: McpToolContribution = {
  name: "classify-change",
  description:
    "Classify the schema change between two revisions of a sql lexicon build, offline. Each side is a `chant build` output (a path to the file, or its JSON text); the dialect is the one the output names, or `dialect`. ClickHouse: every change with its class (create, drop, metadata, rewrite, rebuild), the SQLCH2xx rule and the ClickHouse restriction behind it with its documentation link, the rebuilds a plan must refuse in place with the ClickHouseRebuildOp declaration to run each one as, rename hints, and a rendered report. Postgres: every change with its class by the lock it takes (create, metadata, validate, concurrently, rewrite, expand, drop), the SQLPG2xx rule and its restriction with its Postgres documentation link, the `refused` changes that can only be made as expand and contract with the PostgresMigrationOp declaration to run each column rename or type change across kinds as (`migrationOps`), rename hints and a rendered report; `major` is the server's major (default the newest pinned).",
  inputSchema: {
    type: "object",
    properties: {
      before: { type: "string", description: "The earlier build output: a file path or the JSON text" },
      after: { type: "string", description: "The later build output: a file path or the JSON text" },
      dialect: dialectProp,
      major: majorProp,
    },
    required: ["before", "after"],
  },
  async handler(params) {
    if (buildDialect(params) === "postgres") return classifyPostgres(params);
    const side = (v: unknown) => {
      const text = String(v ?? "");
      return !text.trimStart().startsWith("{") && existsSync(text) ? schemaFromBuildFile(text) : schemaFromBuildOutput(text);
    };
    const after = side(params.after);
    const plain = diffSchemas(side(params.before), after);
    const rebuildOps = rebuildOpSuggestions(plain, new Map(after.map((o) => [o.key, o.canonical])), "<env>");
    const diff = rebuildOps.length > 0 ? { ...plain, rebuildOps } : plain;
    const classes: Record<string, number> = {};
    for (const c of diff.changes) classes[c.class] = (classes[c.class] ?? 0) + 1;
    return {
      summary: classes,
      changes: diff.changes.map((c) => ({ ...c, restriction: CLASSIFIER_RULES[c.rule].restriction, cite: CLASSIFIER_RULES[c.rule].cite })),
      rebuilds: diff.rebuilds,
      rebuildOps,
      hints: diff.hints,
      report: renderDiff(diff),
    };
  },
};

/** The dialect a classify call is for: `dialect`, else the one either build output names, else ClickHouse. */
function buildDialect(params: Record<string, unknown>): "clickhouse" | "postgres" {
  if (params.dialect !== undefined) return asDialect(params.dialect);
  for (const v of [params.after, params.before]) {
    const text = String(v ?? "");
    try {
      const json = text.trimStart().startsWith("{") ? text : existsSync(text) ? readFileSync(text, "utf-8") : "";
      const d = (JSON.parse(json) as { dialect?: string }).dialect;
      if (d === "postgres") return "postgres";
      if (d === "clickhouse") return "clickhouse";
    } catch {
      // Not JSON we can read: the schema reader reports it.
    }
  }
  return "clickhouse";
}

function classifyPostgres(params: Record<string, unknown>): unknown {
  const side = (v: unknown) => {
    const text = String(v ?? "");
    return !text.trimStart().startsWith("{") && existsSync(text) ? pgSchemaFromBuildFile(text) : pgSchemaFromBuildOutput(text);
  };
  const after = side(params.after);
  const plain = diffPgSchemas(side(params.before), after, { major: asMajor(params.major) });
  const migrationOps = migrationOpSuggestions(plain.refused, new Map(after.map((o) => [o.key, o.canonical])), "<env>");
  const diff = migrationOps.length > 0 ? { ...plain, migrationOps } : plain;
  const classes: Record<string, number> = {};
  for (const c of diff.changes) classes[c.class] = (classes[c.class] ?? 0) + 1;
  return {
    dialect: "postgres",
    summary: classes,
    changes: diff.changes.map((c) => ({ ...c, restriction: PG_CLASSIFIER_RULES[c.rule].restriction, cite: PG_CLASSIFIER_RULES[c.rule].cite })),
    refused: diff.refused.map((c) => ({
      object: c.object,
      field: c.field,
      rule: c.rule,
      advice: "No in-place change keeps old readers working: run it as expand and contract (add the new, write both, backfill, move readers, drop the old), as a migration Op.",
    })),
    migrationOps,
    hints: diff.hints,
    report: renderPgDiff(diff),
  };
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

/** The tools the sql lexicon contributes. */
export function sqlMcpTools(): McpToolContribution[] {
  return [
    lookupTool,
    searchTool,
    parseTool,
    classifyTool,
    createDiffTool(sqlSerializer, "Compare current sql build output against the previous build", "sql"),
  ];
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function catalogResource(uri: string, name: string, description: string, read: () => unknown): McpResourceContribution {
  return {
    uri,
    name,
    description,
    mimeType: "application/json",
    async handler() {
      return json(read());
    },
  };
}

const need = () => {
  const index = catalogIndex();
  if (!index) throw new Error("the ClickHouse catalog snapshot could not be read");
  return index.catalog;
};

/** The resources the sql lexicon contributes. */
export function sqlMcpResources(): McpResourceContribution[] {
  return [
    // `generated/` sits beside plugin.ts, which is where the helper looks.
    createCatalogResource(
      new URL("../plugin.ts", import.meta.url).href,
      "SQL Entity Catalog",
      "The entity kinds the sql lexicon declares (database, table, view, materialized view, dictionary, function, user, role, row policy, grant)",
      "lexicon-sql.json",
      "sql",
    ),
    ...postgresMcpResources(),
    catalogResource("clickhouse-pin", "ClickHouse Pin", "The pinned ClickHouse server the catalog was read from", () => ({
      version: CLICKHOUSE_VERSION,
      image: clickhouseImage(),
      digest: CLICKHOUSE_IMAGE_DIGEST,
    })),
    catalogResource("clickhouse-engines", "ClickHouse Engines", "Table and database engines with their usage line, summary and capabilities", () => ({
      tableEngines: need().tableEngines,
      databaseEngines: need().databaseEngines,
    })),
    catalogResource("clickhouse-types", "ClickHouse Types", "Column type families, with aliases and case sensitivity", () => need().typeFamilies),
    catalogResource("clickhouse-codecs", "ClickHouse Codecs", "Column codecs and skip index types", () => ({
      codecs: need().codecs,
      skipIndexTypes: need().skipIndexTypes,
    })),
    catalogResource("clickhouse-settings", "ClickHouse Settings", "MergeTree and query settings with type, default and tier", () => ({
      mergeTreeSettings: need().mergeTreeSettings,
      querySettings: need().querySettings,
    })),
    catalogResource("clickhouse-functions", "ClickHouse Functions", "Function names, with which are aggregate and which are aliases", () => need().functions),
  ];
}
