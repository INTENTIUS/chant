/**
 * A Flyway project's layout, read from a workspace tree (#4400): its
 * `flyway.toml` or `flyway.conf`, the locations it names, read recursively,
 * and the placeholders it substitutes.
 *
 * This is the layout reading of sql-yodeler's `src/check/flyway.ts` (#250),
 * moved here so the workspace kind and `yodel check` share one reader. It
 * works on a {@link WorkspaceTree} and tree-relative paths instead of the
 * file system, and it never runs Flyway or connects to a database.
 *
 * The configuration is the first `flyway.toml`, else `flyway.conf`, found in
 * the directory checked or a directory above it, up to the tree's root. Its
 * locations are read relative to the file's own directory:
 *
 *   filesystem:<path>   that directory
 *   classpath:<path>    src/main/resources/<path> (and, for code
 *   <path>              migrations, src/main/java/<path> and src/main/kotlin/<path>)
 *
 * With no configuration, or one that names no location, the directory
 * checked is the one location. A location outside the tree is reported by
 * {@link FlywayConfig.outside}, not read. A Java or Kotlin migration in a
 * location is not SQL and is reported by {@link codeMigrations}.
 *
 * Placeholders are `${name}` (the prefix and suffix are configurable), from
 * `flyway.placeholders.<name>` (conf) or `[flyway.placeholders]` (toml), plus
 * Flyway's own: `flyway:defaultSchema`, `flyway:user`, `flyway:database`,
 * `flyway:timestamp`, `flyway:filename`, `flyway:workingDirectory`,
 * `flyway:table` and `flyway:environment`. {@link substitute} replaces them
 * for a replay; the reader that lists migrations leaves the text as it is.
 */

import { posix } from "node:path";
import { joinPath, type WorkspaceTree } from "./tree";

export interface FlywayConfig {
  /** The configuration file, tree-relative; undefined with none. */
  file?: string;
  /** Where file names are relative to: the configuration's directory, else the directory checked. Tree-relative. */
  root: string;
  /** The SQL locations, tree-relative directories. */
  locations: string[];
  /** Directories code migrations (Java, Kotlin) of a classpath location would be in. */
  codeLocations: string[];
  /** Locations the configuration names that lie outside the tree, as written. */
  outside: string[];
  placeholders: Record<string, string>;
  placeholderPrefix: string;
  placeholderSuffix: string;
  placeholderReplacement: boolean;
  sqlMigrationPrefix: string;
  repeatableSqlMigrationPrefix: string;
  baselineMigrationPrefix: string;
  undoSqlMigrationPrefix: string;
  sqlMigrationSeparator: string;
  sqlMigrationSuffixes: string[];
  defaultSchema?: string;
  user?: string;
  database?: string;
  /** The JDBC URL, when the configuration has one. */
  url?: string;
  /** The dialect the URL names: `postgres` or `clickhouse`; undefined for another or none. */
  dialect?: string;
  table: string;
  environment?: string;
}

/** The first `flyway.toml`, else `flyway.conf`, in `dir` or a directory above it, up to the tree's root. */
export function findFlywayConfig(tree: WorkspaceTree, dir: string): string | undefined {
  let at = dir;
  for (;;) {
    for (const name of ["flyway.toml", "flyway.conf"]) {
      const f = joinPath(at, name);
      if (tree.stat(f) === "file") return f;
    }
    if (at === "" || at === ".") return undefined;
    at = posix.dirname(at) === "." ? "" : posix.dirname(at);
  }
}

type Values = Record<string, string | string[] | boolean>;

/** Java-properties `flyway.*` keys, without the `flyway.` prefix. */
export function parseFlywayConf(text: string): Values {
  const out: Values = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    while (/\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + (lines[++i] ?? "").trimStart();
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1] ?? "";
    if (!key.startsWith("flyway.")) continue;
    out[key.slice("flyway.".length)] = (m[2] ?? "").trim();
  }
  return out;
}

/** A TOML document, as far as Flyway's configuration uses it: tables, strings, arrays of strings, booleans and numbers. */
export function parseToml(text: string): Record<string, Values> {
  const tables: Record<string, Values> = { "": {} };
  let current = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i] ?? "").trim();
    if (t === "") continue;
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(t);
    if (table) {
      current = (table[1] ?? "").split(".").map((k) => unquote(k.trim())).join(".");
      tables[current] ??= {};
      continue;
    }
    const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.:-]+)\s*=\s*(.*)$/.exec(t);
    if (!kv) continue;
    let raw = kv[2] ?? "";
    // A multi-line array runs to its closing bracket.
    while (raw.trimStart().startsWith("[") && !balanced(raw) && i + 1 < lines.length) raw += ` ${stripComment(lines[++i] ?? "").trim()}`;
    const path = unquote(kv[1] ?? "").split(".");
    const key = path.pop() ?? "";
    const where = [current, ...path].filter(Boolean).join(".");
    tables[where] ??= {};
    tables[where][key] = tomlValue(raw.trim());
  }
  return tables;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const balanced = (s: string) => (s.match(/\[/g) ?? []).length <= (s.match(/\]/g) ?? []).length;

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return s;
}

function tomlValue(raw: string): string | string[] | boolean {
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw.startsWith("[")) {
    const inner = raw.replace(/^\[/, "").replace(/\]\s*$/, "");
    return (inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s]+/g) ?? []).map((v) => unquote(v.trim())).filter((v) => v !== "");
  }
  return unquote(raw);
}

const list = (v: string | string[] | boolean | undefined): string[] | undefined =>
  v === undefined || typeof v === "boolean" ? undefined : Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean);
const str = (v: string | string[] | boolean | undefined): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : undefined);

/** The database name a JDBC URL names: the path after the host. */
function databaseOf(url: string | undefined): string | undefined {
  const m = url === undefined ? null : /^jdbc:[a-z0-9]+:\/\/[^/]+\/([^?;]+)/i.exec(url);
  return m?.[1] ?? undefined;
}

/** The dialect a JDBC URL names. */
function dialectOf(url: string | undefined): string | undefined {
  const m = url === undefined ? null : /^jdbc:([a-z0-9]+):/i.exec(url);
  const driver = m?.[1]?.toLowerCase();
  return driver === "postgresql" ? "postgres" : driver === "clickhouse" ? "clickhouse" : undefined;
}

/** The configuration `file` holds, or the defaults with `dir` as the one location when there is none. */
export function readFlywayConfig(tree: WorkspaceTree, file: string | undefined, dir: string): FlywayConfig {
  let values: Values = {};
  let placeholders: Record<string, string> = {};
  if (file !== undefined) {
    const text = tree.read(file);
    if (file.endsWith(".toml")) {
      const t = parseToml(text);
      const flyway = t.flyway ?? {};
      const name = str(flyway.environment) ?? "default";
      const env = t[`environments.${name}`] ?? {};
      values = { ...flyway, ...(t[`environments.${name}.flyway`] ?? {}), ...(env.url !== undefined ? { url: env.url } : {}), ...(env.user !== undefined ? { user: env.user } : {}), ...(env.schemas !== undefined ? { schemas: env.schemas } : {}) };
      if (str(flyway.environment) !== undefined) values.environment = name;
      placeholders = Object.fromEntries(Object.entries({ ...(t["flyway.placeholders"] ?? {}), ...(t[`environments.${name}.flyway.placeholders`] ?? {}) }).map(([k, v]) => [k, str(v) ?? String(v)]));
    } else {
      values = parseFlywayConf(text);
      placeholders = Object.fromEntries(Object.entries(values).flatMap(([k, v]) => (k.startsWith("placeholders.") ? [[k.slice("placeholders.".length), str(v) ?? ""]] : [])));
    }
  }
  const root = file === undefined ? dir : posix.dirname(file) === "." ? "" : posix.dirname(file);
  const named = list(values.locations) ?? [];
  const locations: string[] = [];
  const codeLocations: string[] = [];
  const outside: string[] = [];
  const inside = (...parts: string[]): string | undefined => {
    const p = posix.normalize(joinPath(...parts)) || ".";
    if (p === ".." || p.startsWith("../") || posix.isAbsolute(p)) return undefined;
    return p === "." ? "" : p;
  };
  for (const l of named) {
    const m = /^(filesystem|classpath):(.*)$/.exec(l);
    const kind = m?.[1] ?? "classpath";
    const raw = m?.[2] ?? l;
    if (kind === "filesystem") {
      const at = posix.isAbsolute(raw) ? undefined : inside(root, raw);
      if (at === undefined) outside.push(l);
      else locations.push(at);
    } else {
      const path = raw.replace(/^\/+/, "");
      const res = inside(root, "src/main/resources", path);
      if (res === undefined) outside.push(l);
      else {
        locations.push(res);
        for (const lang of ["java", "kotlin"]) {
          const c = inside(root, "src/main", lang, path);
          if (c !== undefined) codeLocations.push(c);
        }
      }
    }
  }
  if (named.length === 0) locations.push(dir);
  const schemas = list(values.schemas);
  const replacement = values.placeholderReplacement;
  const defaultSchema = str(values.defaultSchema) ?? schemas?.[0];
  const user = str(values.user);
  const url = str(values.url);
  const database = databaseOf(url);
  const dialect = dialectOf(url);
  const environment = str(values.environment);
  return {
    ...(file !== undefined ? { file } : {}),
    root,
    locations,
    codeLocations,
    outside,
    placeholders,
    placeholderPrefix: str(values.placeholderPrefix) ?? "${",
    placeholderSuffix: str(values.placeholderSuffix) ?? "}",
    placeholderReplacement: !(replacement === false || replacement === "false"),
    sqlMigrationPrefix: str(values.sqlMigrationPrefix) ?? "V",
    repeatableSqlMigrationPrefix: str(values.repeatableSqlMigrationPrefix) ?? "R",
    baselineMigrationPrefix: str(values.baselineMigrationPrefix) ?? "B",
    undoSqlMigrationPrefix: str(values.undoSqlMigrationPrefix) ?? "U",
    sqlMigrationSeparator: str(values.sqlMigrationSeparator) ?? "__",
    sqlMigrationSuffixes: list(values.sqlMigrationSuffixes) ?? [".sql"],
    ...(defaultSchema !== undefined ? { defaultSchema } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(dialect !== undefined ? { dialect } : {}),
    table: str(values.table) ?? "flyway_schema_history",
    ...(environment !== undefined ? { environment } : {}),
  };
}

/** Every file under `dir`, recursively, tree-relative, sorted; none when it does not exist. */
export function walk(tree: WorkspaceTree, dir: string): string[] {
  const entries = tree.list(dir);
  if (!entries) return [];
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = joinPath(dir, e.name);
    if (e.type === "dir") out.push(...walk(tree, p));
    else out.push(p);
  }
  return out;
}

const base = (f: string): string => posix.basename(f);

/** A Flyway SQL callback (`beforeMigrate.sql`, `afterEachMigrate__notify.sql`, ...): run around a migrate, not a migration. */
export const isCallback = (file: string): boolean => /^(before|after)[A-Z][A-Za-z]*(__.*)?\.[A-Za-z]+$/.test(base(file));

/** The code migrations (Java, Kotlin) in `config`'s locations, relative to the tree. */
export function codeMigrations(tree: WorkspaceTree, config: FlywayConfig): string[] {
  const code = /\.(java|kt|class)$/;
  const prefixes = [config.sqlMigrationPrefix, config.repeatableSqlMigrationPrefix, config.baselineMigrationPrefix].filter(Boolean);
  const migration = (f: string) => code.test(f) && prefixes.some((p) => base(f).startsWith(p)) && base(f).includes(config.sqlMigrationSeparator);
  return [...new Set([...config.locations, ...config.codeLocations])].flatMap((d) => walk(tree, d)).filter(migration);
}

/** The values Flyway gives its own placeholders, for `file`. */
function builtins(config: FlywayConfig, file: string, fallback: { defaultSchema?: string | undefined }): Record<string, string | undefined> {
  return {
    "flyway:defaultSchema": config.defaultSchema ?? fallback.defaultSchema,
    "flyway:user": config.user,
    "flyway:database": config.database,
    "flyway:timestamp": new Date().toISOString().replace("T", " ").replace(/\..*$/, ""),
    "flyway:filename": base(file),
    "flyway:workingDirectory": process.cwd(),
    "flyway:table": config.table,
    "flyway:environment": config.environment,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A placeholder with no value; `file` is as the caller passed it, `line` is from 1. */
export class FlywayPlaceholderError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly placeholder: string,
    readonly name: string,
    readonly where: string,
  ) {
    super(`${file}:${String(line)}: no value for the placeholder ${placeholder}; set it in ${where} (flyway.placeholders.${name} in flyway.conf, [flyway.placeholders] in flyway.toml)`);
  }
}

/**
 * `text` with its placeholders replaced, line by line so line numbers hold.
 * A placeholder with no value throws a {@link FlywayPlaceholderError} naming
 * `file` and the line, as Flyway's own run would fail.
 */
export function substitute(text: string, file: string, config: FlywayConfig, fallback: { defaultSchema?: string | undefined } = {}): string {
  if (!config.placeholderReplacement) return text;
  const values: Record<string, string | undefined> = { ...builtins(config, file, fallback), ...config.placeholders };
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const pattern = new RegExp(`${escape(config.placeholderPrefix)}([A-Za-z0-9_.:-]+)${escape(config.placeholderSuffix)}`, "g");
  return text
    .split("\n")
    .map((line, i) =>
      line.replace(pattern, (whole, name: string) => {
        const v = values[name] ?? lower.get(name.toLowerCase());
        if (v === undefined) {
          const where = config.file === undefined ? "a flyway.toml or flyway.conf beside the migrations" : config.file;
          throw new FlywayPlaceholderError(file, i + 1, whole, name, where);
        }
        return v;
      }),
    )
    .join("\n");
}
