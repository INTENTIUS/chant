/**
 * The MySQL catalog: the surface of the MySQL 8.0 dialect, in the shape the
 * committed snapshot stores (#5449).
 *
 * It holds what a declaration, the linter and the editor need to know about the
 * language and not about any one database: the column types with the
 * parameters each takes, the storage engines, character sets, index types, row
 * formats, referential actions and the reserved words that need quoting. The
 * snapshot is written one entry per line and every list is sorted, so a pin move
 * is a line diff.
 *
 * {@link parseMysqlCatalog} validates a snapshot and returns it. Reading the
 * lists from a running server (`information_schema.CHARACTER_SETS`,
 * `SHOW ENGINES`, `information_schema.KEYWORDS`) is a read the reader of that
 * server makes against the same shape.
 */

/** The family a column type belongs to, as the manual groups them. */
export type MysqlTypeFamily = "integer" | "fixed" | "float" | "bit" | "temporal" | "character" | "binary" | "text" | "blob" | "enumeration" | "json" | "spatial";

/** What a type's parentheses take. */
export type MysqlTypeParameters =
  /** No parentheses. */
  | { kind: "none" }
  /** A display width (`INT(11)`), deprecated for the integer types in 8.0. */
  | { kind: "display-width" }
  /** A length: characters for `CHAR`, bytes for `BINARY`. Required for `VARCHAR` and `VARBINARY`. */
  | { kind: "length"; required: boolean; max: number }
  /** `(precision)` or `(precision, scale)`, as `DECIMAL(10, 2)`. */
  | { kind: "precision-scale"; maxPrecision: number; maxScale: number }
  /** Fractional seconds precision `(fsp)`, 0 to 6. */
  | { kind: "fsp"; max: number }
  /** A bit count `(M)`, 1 to 64. */
  | { kind: "bits"; max: number }
  /** A list of values, as `ENUM('a', 'b')`. Required. */
  | { kind: "values" };

export interface TypeRow {
  /** The canonical name, upper case: `INT`. */
  name: string;
  family: MysqlTypeFamily;
  /** The other spellings the server accepts for it: `INTEGER`. */
  aliases: string[];
  parameters: MysqlTypeParameters;
  /** The attributes the type takes in a column definition. */
  attributes: string[];
}

export interface EngineRow {
  name: string;
  /** A table can be declared on it. False for an engine the server has but does not take for a user table (`PERFORMANCE_SCHEMA`). */
  declarable: boolean;
  /** The engine's default for a table with no `ENGINE`. */
  default?: boolean;
  /** Tables on it are transactional. */
  transactional: boolean;
}

export interface CharsetRow {
  name: string;
  /** The collation a column of the set gets with no `COLLATE`. */
  defaultCollation: string;
  /** The most bytes one character takes. */
  maxLength: number;
}

export interface KeywordRow {
  word: string;
  reserved: boolean;
}

export interface MysqlCatalog {
  /** The major line, `8.0`. */
  major: string;
  /** The minor the lists were checked against. */
  version: string;
  /** Where the lists came from: `manual` for the reference manual, `server` for a read of one. */
  source: "manual" | "server";
  types: TypeRow[];
  engines: EngineRow[];
  charsets: CharsetRow[];
  indexTypes: string[];
  rowFormats: string[];
  referentialActions: string[];
  /** The clauses a column definition takes beside its type. */
  columnAttributes: string[];
  keywords: KeywordRow[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The problems a catalog has, empty when it is whole. */
export function mysqlCatalogProblems(c: MysqlCatalog): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const t of c.types) {
    for (const n of [t.name, ...t.aliases]) {
      const had = seen.get(n);
      if (had) problems.push(`type name ${n} is spelled by both ${had} and ${t.name}`);
      else seen.set(n, t.name);
    }
    if (t.name !== t.name.toUpperCase()) problems.push(`type ${t.name} is not upper case`);
  }
  for (const [what, names] of [
    ["engines", c.engines.map((e) => e.name)],
    ["charsets", c.charsets.map((s) => s.name)],
    ["keywords", c.keywords.map((k) => k.word)],
    ["indexTypes", c.indexTypes],
    ["rowFormats", c.rowFormats],
    ["referentialActions", c.referentialActions],
  ] as const) {
    if (new Set(names).size !== names.length) problems.push(`${what} has a name twice`);
    if (names.some((n, i) => i > 0 && compare(names[i - 1]!, n) > 0)) problems.push(`${what} is not sorted`);
  }
  if (c.engines.filter((e) => e.default).length !== 1) problems.push("exactly one engine is the default");
  for (const k of c.keywords) if (k.word !== k.word.toUpperCase()) problems.push(`keyword ${k.word} is not upper case`);
  return problems;
}

/** Parse a snapshot's text and check it is whole. Throws with every problem. */
export function parseMysqlCatalog(text: string): MysqlCatalog {
  const raw = JSON.parse(text) as MysqlCatalog;
  for (const key of ["major", "version", "source", "types", "engines", "charsets", "indexTypes", "rowFormats", "referentialActions", "columnAttributes", "keywords"] as const) {
    if (raw[key] === undefined) throw new Error(`the MySQL catalog has no ${key}`);
  }
  const problems = mysqlCatalogProblems(raw);
  if (problems.length > 0) throw new Error(`the MySQL ${raw.major} catalog is not whole:\n  ${problems.join("\n  ")}`);
  return raw;
}
