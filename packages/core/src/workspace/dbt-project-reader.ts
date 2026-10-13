/**
 * The `dbt-project` link reader (#3932): a dbt project's sources, as links to
 * the tables and columns a sql member exposes (#3931).
 *
 * The reader parses YAML and nothing else. It never runs dbt, never renders
 * Jinja and never reads `profiles.yml` or a target, so the links it derives
 * are the same in every environment.
 *
 * - The project is `dbt_project.yml`. Sources are read from every `.yml` and
 *   `.yaml` file under its `model-paths` (`source-paths` in older projects;
 *   `models` when it names neither), as dbt reads them.
 * - Each enabled source table links to `<schema>.<table>`, and each of its
 *   `columns` to `<schema>.<table>.<column>`. The schema is the source's
 *   `schema`, or the source's `name` when it sets none, which is dbt's own
 *   fallback. The table is its `identifier`, or its `name`. `database` is not
 *   part of the name: a Postgres output has none, and dbt-clickhouse reads a
 *   source's `schema` as the ClickHouse database.
 * - Case follows the member's `dialect` field. For `postgres`, an unquoted
 *   name folds to lowercase and a quoted one keeps its case. dbt quotes a
 *   source's schema and identifier on Postgres unless `quoting:` (in
 *   `dbt_project.yml`, on the source, or on the table) turns it off, and a
 *   column is quoted only with `quote: true`. For `clickhouse`, names are
 *   kept as written.
 * - A value that is a Jinja template (`{{ ... }}` or `{% ... %}`) is not
 *   resolved: the reader records a gap and leaves that source, table or
 *   column out, rather than guess what a target would render.
 * - The producer is the member the `sqlMember` field names. Unset, each link
 *   leaves the producer to `resolveLinks`, which picks the one member that
 *   exposes the table.
 */

import { posix } from "node:path";
import { parseYAMLDocument, YAMLParseError } from "../yaml";
import type { KindLinkRead, KindReadGap, KindReadLink, KindReaderInput } from "./kind-link-readers";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";

export const DBT_PROJECT_FILE = "dbt_project.yml";
const DEFAULT_MODEL_PATHS = ["models"];

/** The dialects whose naming the reader follows; the member's `dialect` field picks one. */
export const DBT_DIALECTS = ["postgres", "clickhouse"] as const;
type Dialect = (typeof DBT_DIALECTS)[number];

interface Quoting {
  schema: boolean;
  identifier: boolean;
}

const isTemplated = (v: string) => /\{\{|\{%/.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function readDbtProject(input: KindReaderInput): KindLinkRead {
  const { dir, tree, fields } = input;
  const links: KindReadLink[] = [];
  const gaps: KindReadGap[] = [];
  const result: KindLinkRead = { reader: "dbt-project", links, gaps, producerField: "sqlMember" };
  const projectFile = joinPath(dir, DBT_PROJECT_FILE);

  const producer = typeof fields?.sqlMember === "string" && fields.sqlMember !== "" ? fields.sqlMember : null;
  const dialect: Dialect = fields?.dialect === "clickhouse" ? "clickhouse" : "postgres";

  let project: unknown;
  try {
    project = parseYAMLDocument(tree.read(projectFile));
  } catch (err) {
    gaps.push({ file: projectFile, line: err instanceof YAMLParseError ? err.line : 1, message: `${DBT_PROJECT_FILE} could not be read (${(err as Error).message}), so no source was read` });
    return result;
  }
  if (!isObject(project)) {
    gaps.push({ file: projectFile, line: 1, message: `${DBT_PROJECT_FILE} is not a mapping, so no source was read` });
    return result;
  }
  const projectLines = lines(tree.read(projectFile));

  // Where sources live: model-paths, or the older source-paths.
  const key = project["model-paths"] !== undefined ? "model-paths" : project["source-paths"] !== undefined ? "source-paths" : null;
  const rawPaths = key ? project[key] : DEFAULT_MODEL_PATHS;
  const paths: string[] = [];
  if (!Array.isArray(rawPaths)) {
    gaps.push({ file: projectFile, line: keyLine(projectLines, key ?? ""), message: `${key} is not a list, so no source was read` });
    return result;
  }
  for (const p of rawPaths) {
    if (typeof p !== "string" || isTemplated(p)) {
      gaps.push({ file: projectFile, line: keyLine(projectLines, key ?? ""), message: `${key} entry ${JSON.stringify(p)} is not a plain path; its sources were not read` });
      continue;
    }
    const at = posix.normalize(joinPath(dir, p));
    if (at.startsWith("../") || at === ".." || posix.isAbsolute(p)) {
      gaps.push({ file: projectFile, line: keyLine(projectLines, key ?? ""), message: `${key} entry ${p} lies outside the workspace; its sources were not read` });
      continue;
    }
    paths.push(at === "." ? "" : at);
  }

  const quoting = readQuoting({ schema: true, identifier: true }, project.quoting, projectFile, keyLine(projectLines, "quoting"), "dbt_project.yml quoting", gaps);

  const files = new Set<string>();
  for (const p of paths) for (const f of yamlFiles(tree, p)) files.add(f);
  const name = (v: string, quoted: boolean) => (dialect === "postgres" && !quoted ? v.toLowerCase() : v);

  for (const file of [...files].sort()) {
    let text: string;
    let doc: unknown;
    try {
      text = tree.read(file);
      doc = parseYAMLDocument(text);
    } catch (err) {
      gaps.push({ file, line: err instanceof YAMLParseError ? err.line : 1, message: `the file could not be read as YAML (${(err as Error).message}); any sources in it were not read` });
      continue;
    }
    if (!isObject(doc) || doc.sources === undefined || doc.sources === null) continue;
    const fileLines = lines(text);
    const sourcesLine = keyLine(fileLines, "sources");
    if (!Array.isArray(doc.sources)) {
      gaps.push({ file, line: sourcesLine, message: "sources is not a list; its sources were not read" });
      continue;
    }
    let cursor = sourcesLine;
    for (const source of doc.sources) {
      if (!isObject(source)) continue;
      const sourceName = scalar(source.name);
      const sourceLine = nameLine(fileLines, sourceName, cursor);
      cursor = sourceLine;
      if (sourceName === undefined) {
        gaps.push({ file, line: sourceLine, message: "a source has no name; its tables were not read" });
        continue;
      }
      const where = `source ${sourceName}`;
      if (isTemplated(sourceName)) {
        gaps.push({ file, line: sourceLine, message: `${where}: its name is a Jinja template, which chant does not render; its tables were not read` });
        continue;
      }
      const enabled = readEnabled(source, file, sourceLine, where, gaps);
      if (enabled !== true) continue;
      const schema = source.schema === undefined || source.schema === null ? sourceName : scalar(source.schema);
      if (schema === undefined || isTemplated(schema)) {
        gaps.push({
          file,
          line: valueLine(fileLines, "schema", sourceLine),
          message: `${where}: schema ${JSON.stringify(source.schema)} is a Jinja template or not a name; chant reads names as declared and never renders them for a target, so its tables were not read`,
        });
        continue;
      }
      const sourceQuoting = readQuoting(quoting, source.quoting, file, sourceLine, `${where} quoting`, gaps);
      if (source.tables === undefined || source.tables === null) continue;
      if (!Array.isArray(source.tables)) {
        gaps.push({ file, line: sourceLine, message: `${where}: tables is not a list; its tables were not read` });
        continue;
      }
      let tableCursor = sourceLine;
      for (const table of source.tables) {
        if (!isObject(table)) continue;
        const tableName = scalar(table.name);
        const tableLine = nameLine(fileLines, tableName, tableCursor);
        tableCursor = tableLine;
        if (tableName === undefined) {
          gaps.push({ file, line: tableLine, message: `${where}: a table has no name; it was not read` });
          continue;
        }
        const tableWhere = `${where} table ${tableName}`;
        if (isTemplated(tableName)) {
          gaps.push({ file, line: tableLine, message: `${tableWhere}: its name is a Jinja template, which chant does not render; it was not read` });
          continue;
        }
        if (readEnabled(table, file, tableLine, tableWhere, gaps) !== true) continue;
        const identifier = table.identifier === undefined || table.identifier === null ? tableName : scalar(table.identifier);
        if (identifier === undefined || isTemplated(identifier)) {
          gaps.push({
            file,
            line: valueLine(fileLines, "identifier", tableLine),
            message: `${tableWhere}: identifier ${JSON.stringify(table.identifier)} is a Jinja template or not a name, which chant does not render; it was not read`,
          });
          continue;
        }
        const q = readQuoting(sourceQuoting, table.quoting, file, tableLine, `${tableWhere} quoting`, gaps);
        const tableOutput = `${name(schema, q.schema)}.${name(identifier, q.identifier)}`;
        links.push({ member: producer, output: tableOutput, file, line: tableLine });
        if (table.columns === undefined || table.columns === null) continue;
        if (!Array.isArray(table.columns)) {
          gaps.push({ file, line: tableLine, message: `${tableWhere}: columns is not a list; its columns were not read` });
          continue;
        }
        let columnCursor = tableLine;
        for (const column of table.columns) {
          if (!isObject(column)) continue;
          const columnName = scalar(column.name);
          const columnLine = nameLine(fileLines, columnName, columnCursor);
          columnCursor = columnLine;
          if (columnName === undefined || isTemplated(columnName)) {
            gaps.push({ file, line: columnLine, message: `${tableWhere}: column ${JSON.stringify(column.name)} is a Jinja template or not a name, which chant does not render; it was not read` });
            continue;
          }
          const quoted = column.quote === true;
          links.push({ member: producer, output: `${tableOutput}.${name(columnName, quoted)}`, anchor: tableOutput, file, line: columnLine });
        }
      }
    }
  }
  return result;
}

/** A name as text: a string, or a number or boolean YAML read as one. */
function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Whether an entry is enabled: `enabled`, or `config.enabled`. A templated value is a gap, and the entry is left out. */
function readEnabled(entry: Record<string, unknown>, file: string, line: number, where: string, gaps: KindReadGap[]): boolean {
  const config = isObject(entry.config) ? entry.config : {};
  const raw = entry.enabled ?? config.enabled;
  if (raw === undefined || raw === null || raw === true) return true;
  if (raw === false) return false;
  gaps.push({ file, line, message: `${where}: enabled is ${JSON.stringify(raw)}, which chant does not render; it was not read` });
  return false;
}

/** `base` with a `quoting:` block's schema and identifier applied. A value that isn't a boolean is a gap and keeps the base. */
function readQuoting(base: Quoting, raw: unknown, file: string, line: number, where: string, gaps: KindReadGap[]): Quoting {
  if (raw === undefined || raw === null) return base;
  if (!isObject(raw)) {
    gaps.push({ file, line, message: `${where} is not a mapping; the quoting above it applies` });
    return base;
  }
  const out = { ...base };
  for (const key of ["schema", "identifier"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[key] = v;
    else gaps.push({ file, line, message: `${where}.${key} is ${JSON.stringify(v)}, not true or false; the quoting above it applies` });
  }
  return out;
}

/** Every `.yml` and `.yaml` file under tree-relative directory `dir`, skipping dot directories and node_modules. */
function yamlFiles(tree: WorkspaceTree, dir: string): string[] {
  if (dir !== "" && tree.stat(dir) !== "dir") return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of tree.list(at) ?? []) {
      const path = joinPath(at, e.name);
      if (e.type === "dir") {
        if (!skippedDir(e.name)) walk(path);
      } else if (/\.ya?ml$/.test(e.name)) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

function lines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The line (from 1) of top-level key `key`, or 1. */
function keyLine(fileLines: string[], key: string): number {
  const re = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  const i = fileLines.findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

/**
 * The line of the first `name: <value>` entry after line `from`, or `from`
 * itself. Sources, tables and columns are listed in file order, so
 * searching on from the parent's line finds each one's own line. A file in
 * flow style has no such lines, and its entries are reported at the parent.
 */
function nameLine(fileLines: string[], value: string | undefined, from: number): number {
  return value === undefined ? from : valueLineOf(fileLines, "name", value, from);
}

/** The line of the first `<key>:` after line `from`, or `from`. */
function valueLine(fileLines: string[], key: string, from: number): number {
  const re = new RegExp(`^\\s*(?:-\\s+)?${escapeRegExp(key)}\\s*:`);
  for (let i = Math.max(from, 0); i < fileLines.length; i++) if (re.test(fileLines[i])) return i + 1;
  return from;
}

function valueLineOf(fileLines: string[], key: string, value: string, from: number): number {
  const re = new RegExp(`^\\s*(?:-\\s+)?${escapeRegExp(key)}\\s*:\\s*(["']?)${escapeRegExp(value)}\\1\\s*(?:#.*)?$`);
  for (let i = Math.max(from, 0); i < fileLines.length; i++) if (re.test(fileLines[i])) return i + 1;
  return from;
}
