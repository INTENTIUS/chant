/**
 * A MySQL object's canonical form: what a plan compares, read from a `CREATE`
 * statement, so a declaration and the server's `SHOW CREATE` compare equal
 * when they create the same object.
 *
 * Both sides are parsed with the same parser (`./parser.ts`) and brought to
 * the spelling MySQL 8.0's `SHOW CREATE TABLE` prints:
 *
 * - a type by its canonical name in lower case (`INTEGER` is `int`, `BOOL`
 *   is `tinyint(1)`), an integer's display width dropped (8.0.19 and later
 *   print none, except `tinyint(1)` and with `ZEROFILL`), `DECIMAL` with its
 *   default precision and scale, a zero fractional-seconds precision dropped;
 * - a default as the server prints it: a number in a numeric column without
 *   quotes and with the column's scale, `NOW()` as `CURRENT_TIMESTAMP`,
 *   `TRUE` as `1`, `DEFAULT NULL` as no default;
 * - the names the server gives what the declaration leaves unnamed: an index
 *   after its first column (`email`, `email_2`), a foreign key
 *   `<table>_ibfk_<n>`, a check `<table>_chk_<n>`, and the index InnoDB adds
 *   for a foreign key that no index serves;
 * - `utf8` as `utf8mb3`, character sets and collations in lower case, a
 *   column's character set or collation dropped where it is the table's;
 * - an expression (a check, a generated column, a view's query) with its
 *   quotes, qualifiers, grouping parentheses, introducers and the aliases the
 *   server adds taken off, so `CHECK (a > 0)` and `CHECK ((\`a\` > 0))` are
 *   the same.
 *
 * What the declaration does not say is not compared: a table's engine,
 * character set, collation and row format, an index's `USING`, a view's
 * `ALGORITHM` and `SQL SECURITY` are compared only when declared, and a
 * view's definer and a table's `AUTO_INCREMENT` counter never are.
 */

import { isTrivia, stringValue, tokenizeText, unquote, type Token } from "./tokens";
import { parseMysqlCreate, type ColumnNode, type KeyNode, type MysqlCreateNode, type TableNode } from "./parser";
import type { Span } from "../core/cursor";
import { COLUMN_TYPES, ENGINES } from "../generated/mysql";
import { stripMarker } from "../core/ownership";
import { MYSQL_ENTITY_TYPES, type MysqlEntityType } from "./entities";
import { mysqlString, quoteIdent } from "./names";

export interface CanonicalColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  /** The default as written, for `SET DEFAULT`; never compared. */
  defaultSql?: string;
  onUpdate?: string;
  autoIncrement: boolean;
  /** `<expr> VIRTUAL` or `<expr> STORED`. */
  generated?: string;
  charset?: string;
  collate?: string;
  comment: string;
  invisible: boolean;
  srid?: string;
  /** The column's definition as SQL, for `ADD COLUMN` and `MODIFY COLUMN`; never compared. */
  definition: string;
}

export interface CanonicalIndex {
  name: string;
  kind: "unique" | "index" | "fulltext" | "spatial";
  /** The key parts, as one string: `email(10),created_at DESC`. */
  parts: string;
  using?: string;
  comment: string;
  invisible: boolean;
  /** `UNIQUE INDEX name (parts) ...` as SQL, for `ADD`; never compared. */
  definition: string;
}

export interface CanonicalForeignKey {
  name: string;
  columns: string;
  /** `db.table`. */
  references: string;
  refColumns: string;
  onDelete: string;
  onUpdate: string;
  /** `CONSTRAINT name FOREIGN KEY ...` as SQL, for `ADD`; never compared. */
  definition: string;
}

export interface CanonicalCheck {
  name: string;
  expr: string;
  enforced: boolean;
  /** `CONSTRAINT name CHECK (...)` as SQL, for `ADD`; never compared. */
  definition: string;
}

interface Base {
  /** The database the object is in; absent for a database itself. */
  database?: string;
  name: string;
  /** The `-- previously: <old name>` hint in the statement, if any. */
  previously?: string;
}

export interface CanonicalDatabase extends Base {
  kind: "database";
  charset?: string;
  collate?: string;
}

export interface CanonicalTable extends Base {
  kind: "table";
  database: string;
  columns: CanonicalColumn[];
  /** The primary key's parts, as an index's are written; absent when it has none. */
  primaryKey?: string;
  /** The primary key's parts as SQL, `(\`a\`,\`b\`)`; never compared. */
  primaryKeySql?: string;
  indexes: CanonicalIndex[];
  foreignKeys: CanonicalForeignKey[];
  checks: CanonicalCheck[];
  engine?: string;
  charset?: string;
  collate?: string;
  /** The table's comment, chant's ownership trailer taken off. */
  comment: string;
  /** The comment as the server holds it, trailer included (live side only). */
  rawComment?: string;
  rowFormat?: string;
  /** Every other table option but `AUTO_INCREMENT`, by its upper-case name. */
  options: Record<string, string>;
}

export interface CanonicalView extends Base {
  kind: "view";
  database: string;
  columns: string[];
  query: string;
  algorithm?: string;
  security?: string;
  checkOption?: string;
}

export type CanonicalObject = CanonicalDatabase | CanonicalTable | CanonicalView;

export const ENTITY_TYPE_OF: Readonly<Record<CanonicalObject["kind"], MysqlEntityType>> = {
  database: MYSQL_ENTITY_TYPES.database,
  table: MYSQL_ENTITY_TYPES.table,
  view: MYSQL_ENTITY_TYPES.view,
};

/** An object's key in a plan: `table shop.users`, `database shop`. */
export const objectKey = (o: { kind: string; database?: string; name: string }): string => `${o.kind} ${o.database !== undefined ? `${o.database}.` : ""}${o.name}`;

// ── Tokens to text ────────────────────────────────────────────────────

const sigOf = (tokens: readonly Token[], span: Span | undefined): Token[] => (span ? tokens.slice(span.from, span.to).filter((t) => !isTrivia(t)) : []);

const raw = (tokens: readonly Token[], span: Span | undefined): string | undefined => (span && span.to > span.from ? tokens.slice(span.from, span.to).map((t) => t.text).join("").trim() : undefined);

const nameIn = (tokens: readonly Token[], span: Span): string => {
  const t = sigOf(tokens, span)[0];
  return t ? unquote(t.text) : "";
};

function qualifiedIn(tokens: readonly Token[], span: Span, defaultDatabase: string): { database: string; name: string } {
  const parts = sigOf(tokens, span)
    .filter((t) => !(t.kind === "punct" && t.text === "."))
    .map((t) => unquote(t.text));
  return parts.length >= 2 ? { database: parts[parts.length - 2]!, name: parts[parts.length - 1]! } : { database: defaultDatabase, name: parts[0] ?? "" };
}

/** A string literal as MySQL prints it: single-quoted, a quote doubled, a backslash escaped. */
const quoted = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/** Words after which `(` groups rather than calls. */
const GROUPING_WORDS = new Set(["and", "or", "not", "xor", "when", "then", "else", "case", "is", "between", "like", "select", "where", "on", "from", "as", "by", "having", "return", "in", "exists", "join", "union", "all", "distinct", "with", "using", "regexp", "rlike", "div", "mod"]);

/**
 * An expression's tokens as comparable text: quotes, qualifiers, introducers
 * and grouping parentheses off, names and key words in lower case,
 * `count(*)` as the server stores it, `count(0)`.
 */
export function normalizeExpression(sig: readonly Token[]): string {
  // Introducers (`_utf8mb4'x'`) and qualifiers (`t.a`, `db.t.a`).
  const words: Array<{ kind: Token["kind"]; text: string }> = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!;
    const next = sig[i + 1];
    if (t.kind === "ident" && /^_[a-z0-9]+$/i.test(t.text) && next?.kind === "string") continue;
    if ((t.kind === "ident" || t.kind === "qident") && next?.kind === "punct" && next.text === "." && sig[i + 2] !== undefined && (sig[i + 2]!.kind === "ident" || sig[i + 2]!.kind === "qident" || sig[i + 2]!.text === "*")) {
      i++;
      continue;
    }
    if (t.kind === "qident") words.push({ kind: "ident", text: unquote(t.text).toLowerCase() });
    else if (t.kind === "ident") words.push({ kind: "ident", text: t.text.toLowerCase() });
    else if (t.kind === "string") words.push({ kind: "string", text: quoted(stringValue(t.text)) });
    else if (t.text === "!=") words.push({ kind: "op", text: "<>" });
    else if (t.text === "&&") words.push({ kind: "ident", text: "and" });
    else if (t.text === "||") words.push({ kind: "ident", text: "or" });
    else words.push({ kind: t.kind, text: t.text });
  }
  // `INNER JOIN`, `CROSS JOIN` and `LEFT OUTER JOIN` as the server prints them.
  const joined = words.filter((w, i) => !(w.kind === "ident" && (w.text === "inner" || w.text === "cross" || w.text === "outer") && words[i + 1]?.text === "join"));
  // Grouping parentheses off; a call's kept.
  const drop = new Set<number>();
  const stack: Array<{ at: number; grouping: boolean }> = [];
  joined.forEach((w, i) => {
    if (w.kind === "punct" && w.text === "(") {
      const prev = joined[i - 1];
      const call = prev !== undefined && prev.kind === "ident" && !GROUPING_WORDS.has(prev.text);
      stack.push({ at: i, grouping: !call });
    } else if (w.kind === "punct" && w.text === ")") {
      const open = stack.pop();
      if (open?.grouping) {
        drop.add(open.at);
        drop.add(i);
      }
    }
  });
  const kept = joined.filter((_, i) => !drop.has(i)).map((w) => w.text);
  return kept.join(" ").replace(/\bcount \( \* \)/g, "count ( 0 )");
}

/** A view's query as comparable text: {@link normalizeExpression}, less each alias that only repeats its item. */
export function normalizeQuery(sig: readonly Token[]): string {
  const text = normalizeExpression(sig);
  const words = text.split(" ");
  const out: string[] = [];
  let itemStart = 0;
  let depth = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "(") depth++;
    if (w === ")") depth--;
    if (depth === 0 && (w === "select" || w === "," || w === "distinct")) {
      out.push(w);
      itemStart = out.length;
      continue;
    }
    if (depth === 0 && w === "as" && words[i + 1] !== undefined) {
      const item = out.slice(itemStart).join("");
      const alias = words[i + 1]!.replace(/\s+/g, "");
      const unquotedAlias = alias.replace(/^'(.*)'$/, "$1");
      if (item === unquotedAlias || item.replace(/count\(0\)/g, "count(*)") === unquotedAlias) {
        i++;
        continue;
      }
    }
    out.push(w);
  }
  return out.join(" ");
}

// ── Types and defaults ────────────────────────────────────────────────

const INTEGERS = new Set(["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT"]);

/** A column type as MySQL 8.0's `SHOW CREATE TABLE` prints it. */
export function normalizeType(name: string, typeTokens: readonly Token[]): string {
  const sig = typeTokens.filter((t) => !isTrivia(t));
  const open = sig.findIndex((t) => t.kind === "punct" && t.text === "(");
  let close = -1;
  if (open >= 0) {
    let depth = 0;
    for (let i = open; i < sig.length; i++) {
      if (sig[i]!.text === "(") depth++;
      else if (sig[i]!.text === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
  }
  const params = open >= 0 && close > open ? sig.slice(open + 1, close) : [];
  const flags = sig.slice(close >= 0 ? close + 1 : open >= 0 ? sig.length : 0).filter((t) => t.kind === "ident").map((t) => t.text.toUpperCase());
  const zerofill = flags.includes("ZEROFILL");
  const unsigned = flags.includes("UNSIGNED") || zerofill;
  const nums = params.filter((t) => t.kind === "number").map((t) => t.text);
  let base = name;
  let args: string | undefined = nums.length > 0 ? nums.join(",") : undefined;
  if (name === "BOOLEAN") return "tinyint(1)";
  if (name === "ENUM" || name === "SET") {
    args = params.filter((t) => t.kind === "string").map((t) => quoted(stringValue(t.text))).join(",");
  } else if (INTEGERS.has(name)) {
    if (!(zerofill || (name === "TINYINT" && args === "1"))) args = undefined;
  } else if (name === "DECIMAL") {
    args = nums.length === 0 ? "10,0" : nums.length === 1 ? `${nums[0]},0` : args;
  } else if (name === "FLOAT" && nums.length === 1) {
    base = Number(nums[0]) > 24 ? "DOUBLE" : "FLOAT";
    args = undefined;
  } else if ((name === "CHAR" || name === "BINARY" || name === "BIT") && args === undefined) {
    args = "1";
  } else if ((name === "DATETIME" || name === "TIME" || name === "TIMESTAMP") && args === "0") {
    args = undefined;
  } else if (name === "YEAR") {
    args = undefined;
  } else if ((name === "TEXT" || name === "BLOB") && args !== undefined) {
    const bytes = Number(args) * (name === "TEXT" ? 4 : 1);
    const prefix = bytes < 256 ? "TINY" : bytes < 65536 ? "" : bytes < 16777216 ? "MEDIUM" : "LONG";
    base = `${prefix}${name}`;
    args = undefined;
  }
  return `${base.toLowerCase()}${args !== undefined ? `(${args})` : ""}${unsigned ? " unsigned" : ""}${zerofill ? " zerofill" : ""}`;
}

const NOW = /^(current_timestamp|now|localtime|localtimestamp)$/i;

/** `NOW()`, `CURRENT_TIMESTAMP(3)`, `LOCALTIME` as the server prints them, or undefined for anything else. */
function currentTimestamp(sig: readonly Token[]): string | undefined {
  if (sig[0]?.kind !== "ident" || !NOW.test(sig[0].text)) return undefined;
  const fsp = sig.find((t) => t.kind === "number")?.text;
  if (sig.length > 1 && !(sig[1]?.text === "(" && sig[sig.length - 1]?.text === ")")) return undefined;
  return fsp && fsp !== "0" ? `CURRENT_TIMESTAMP(${fsp})` : "CURRENT_TIMESTAMP";
}

/** A number as a column of `type` prints it: an integer bare, a fixed-point number with its scale. */
function numeric(type: string, value: string): string | undefined {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) return undefined;
  const fixed = /^decimal\(\d+,(\d+)\)/.exec(type);
  if (fixed) return n.toFixed(Number(fixed[1]));
  if (/^(tinyint|smallint|mediumint|int|bigint)\b/.test(type)) return /^[+-]?\d+$/.test(value.trim()) ? BigInt(value.trim()).toString() : String(Math.trunc(n));
  if (/^(float|double)\b/.test(type)) return String(n);
  return undefined;
}

/** A column default as MySQL 8.0 prints it, or undefined for none. */
export function normalizeDefault(type: string, sig: readonly Token[]): string | undefined {
  if (sig.length === 0) return undefined;
  if (sig.length === 1 && sig[0]!.kind === "ident" && sig[0]!.text.toUpperCase() === "NULL") return undefined;
  const now = currentTimestamp(sig);
  if (now) return now;
  if (sig[0]!.kind === "punct" && sig[0]!.text === "(") return `(${normalizeExpression(sig.slice(1, -1))})`;
  const numericType = /^(tinyint|smallint|mediumint|int|bigint|decimal|float|double)\b/.test(type);
  if (sig.length === 1 && sig[0]!.kind === "ident" && /^(true|false)$/i.test(sig[0]!.text)) {
    const v = sig[0]!.text.toLowerCase() === "true" ? "1" : "0";
    return numericType ? v : quoted(v);
  }
  // A signed number, a string, or a string after its introducer.
  let sign = "";
  let rest = sig;
  if (sig[0]!.kind === "op" && (sig[0]!.text === "-" || sig[0]!.text === "+")) {
    sign = sig[0]!.text === "-" ? "-" : "";
    rest = sig.slice(1);
  }
  if (rest.length === 2 && rest[0]!.kind === "ident" && rest[1]!.kind === "string") {
    const prefix = rest[0]!.text.toLowerCase();
    if (prefix === "b" || prefix === "x") return `${prefix}${rest[1]!.text}`;
    rest = rest.slice(1);
  }
  if (rest.length !== 1) return sig.map((t) => t.text).join(" ");
  const t = rest[0]!;
  const value = t.kind === "string" ? stringValue(t.text) : `${sign}${t.text}`;
  if (numericType) return numeric(type, value) ?? quoted(value);
  if (/^(datetime|timestamp)\b/.test(type) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return quoted(`${value} 00:00:00`);
  return quoted(value);
}

// ── Character sets ────────────────────────────────────────────────────

/** A character set or collation name as the server prints it: lower case, `utf8` as `utf8mb3`. */
export const charsetName = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  const lower = stringValue(name).toLowerCase();
  return lower === "utf8" || lower.startsWith("utf8_") ? lower.replace(/^utf8/, "utf8mb3") : lower;
};

const ENGINE_NAMES = new Map(Object.keys(ENGINES).map((e) => [e.toLowerCase(), e]));
const engineName = (name: string): string => ENGINE_NAMES.get(stringValue(name).toLowerCase()) ?? stringValue(name);

// ── Statements ────────────────────────────────────────────────────────

const PREVIOUSLY = /--\s*previously:\s*([^\s]+)/i;

/**
 * The canonical form of one `CREATE` statement. `defaultDatabase` is the
 * database an unqualified name is in. Throws the parser's error when the
 * statement does not parse.
 */
export function canonicalObject(ddl: string, defaultDatabase: string): CanonicalObject {
  const tokens = tokenizeText(unversioned(ddl), 0);
  const node = parseMysqlCreate(tokens);
  const prev = PREVIOUSLY.exec(ddl)?.[1];
  const withPrev = <T extends CanonicalObject>(o: T): T => (prev ? { ...o, previously: unquote(prev) } : o);
  return withPrev(canonicalNode(node, tokens, defaultDatabase));
}

/** A statement with MySQL's version comments (`/*!40100 DEFAULT CHARACTER SET utf8mb4 *\/`) opened: the server runs what is in them. */
export function unversioned(ddl: string): string {
  return ddl.replace(/\/\*!\d*\s?([\s\S]*?)\*\//g, " $1 ");
}

function canonicalNode(node: MysqlCreateNode, tokens: readonly Token[], defaultDatabase: string): CanonicalObject {
  const option = (options: ReadonlyArray<{ key: string; value: Span }>, key: string): string | undefined => {
    const o = options.find((x) => x.key === key);
    return o ? raw(tokens, o.value) : undefined;
  };
  if (node.statement === "database") {
    const name = nameIn(tokens, node.name);
    const charset = charsetName(option(node.options, "CHARSET"));
    const collate = charsetName(option(node.options, "COLLATE"));
    return { kind: "database", name, ...(charset ? { charset } : {}), ...(collate ? { collate } : {}) };
  }
  if (node.statement === "view") {
    const { database, name } = qualifiedIn(tokens, node.name, defaultDatabase);
    return {
      kind: "view",
      database,
      name,
      columns: node.columns,
      query: normalizeQuery(sigOf(tokens, node.select)),
      ...(node.algorithm ? { algorithm: node.algorithm } : {}),
      ...(node.security ? { security: node.security } : {}),
      ...(node.checkOption ? { checkOption: node.checkOption } : {}),
    };
  }
  if (node.statement === "index") throw new Error("a CREATE INDEX is part of its table; read it into the table's statement first");
  return canonicalTable(node, tokens, defaultDatabase, option);
}

function canonicalTable(
  node: TableNode,
  tokens: readonly Token[],
  defaultDatabase: string,
  option: (options: ReadonlyArray<{ key: string; value: Span }>, key: string) => string | undefined,
): CanonicalTable {
  const { database, name } = qualifiedIn(tokens, node.name, defaultDatabase);
  const charset = charsetName(option(node.options, "CHARSET"));
  const collate = charsetName(option(node.options, "COLLATE"));
  const comment = option(node.options, "COMMENT");
  const rawComment = comment !== undefined ? stringValue(comment) : "";

  const pkColumns = new Set<string>();
  const pkNode = node.keys.find((k) => k.kind === "primary");
  const inlinePk = node.columns.find((c) => c.key === "primary");
  if (pkNode) for (const p of pkNode.parts) if (p.column) pkColumns.add(nameIn(tokens, p.column).toLowerCase());
  if (inlinePk) pkColumns.add(inlinePk.name.toLowerCase());

  const columns = node.columns.map((c) => canonicalColumn(c, tokens, pkColumns.has(c.name.toLowerCase()), charset, collate));

  const partText = (k: KeyNode) =>
    k.parts
      .map((p) => {
        const head = p.expr ? `(${normalizeExpression(sigOf(tokens, p.expr))})` : `${nameIn(tokens, p.column!)}${p.length ? `(${p.length})` : ""}`;
        return p.desc ? `${head} DESC` : head;
      })
      .join(",");
  const partSql = (k: KeyNode) =>
    `(${k.parts
      .map((p) => {
        const head = p.expr ? `(${raw(tokens, p.expr) ?? ""})` : `${quoteIdent(nameIn(tokens, p.column!))}${p.length ? `(${p.length})` : ""}`;
        return p.desc ? `${head} DESC` : head;
      })
      .join(",")})`;
  const KIND_SQL = { unique: "UNIQUE INDEX", index: "INDEX", fulltext: "FULLTEXT INDEX", spatial: "SPATIAL INDEX" } as const;

  const used = new Set<string>(["primary"]);
  const indexes: CanonicalIndex[] = [];
  const nameFor = (first: string): string => {
    let n = first;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${first}_${i}`;
    used.add(n.toLowerCase());
    return n;
  };
  // Named indexes take their names first, so a generated name steps around them.
  for (const k of node.keys) if (k.kind !== "primary" && k.name) used.add(k.name.toLowerCase());
  for (const c of node.columns.filter((x) => x.key === "unique")) {
    const n = nameFor(c.name);
    indexes.push({ name: n, kind: "unique", parts: c.name, comment: "", invisible: false, definition: `UNIQUE INDEX ${quoteIdent(n)} (${quoteIdent(c.name)})` });
  }
  for (const k of node.keys) {
    if (k.kind === "primary") continue;
    const first = k.parts[0]?.expr ? "functional_index" : k.parts[0]?.column ? nameIn(tokens, k.parts[0].column) : "index";
    const indexName = k.name ?? nameFor(first);
    const kind = k.kind as CanonicalIndex["kind"];
    const definition = [
      `${KIND_SQL[kind]} ${quoteIdent(indexName)} ${partSql(k)}`,
      k.using ? `USING ${k.using}` : "",
      k.parser ? `WITH PARSER ${quoteIdent(k.parser)}` : "",
      k.comment ? `COMMENT ${mysqlString(k.comment)}` : "",
      k.invisible ? "INVISIBLE" : "",
    ]
      .filter(Boolean)
      .join(" ");
    indexes.push({ name: indexName, kind, parts: partText(k), ...(k.using ? { using: k.using } : {}), comment: k.comment ?? "", invisible: k.invisible === true, definition });
  }
  const primaryKey = pkNode ? partText(pkNode) : inlinePk ? inlinePk.name : undefined;
  const primaryKeySql = pkNode ? partSql(pkNode) : inlinePk ? `(${quoteIdent(inlinePk.name)})` : undefined;

  let fkN = 0;
  const foreignKeys: CanonicalForeignKey[] = node.foreignKeys.map((f) => {
    const target = qualifiedIn(tokens, f.table, database);
    const fkName = f.name ?? `${name}_ibfk_${++fkN}`;
    const fkColumns = f.columns.map((s) => nameIn(tokens, s));
    const refColumns = f.refColumns.map((s) => nameIn(tokens, s));
    // InnoDB adds an index for a foreign key that no index starts with its columns, named for the constraint.
    const served = [primaryKey, ...indexes.map((i) => i.parts)].some((parts) => parts !== undefined && `${parts},`.toLowerCase().startsWith(`${fkColumns.join(",")},`.toLowerCase()));
    if (!served) {
      const n = nameFor(f.name ?? f.indexName ?? fkColumns[0] ?? fkName);
      indexes.push({ name: n, kind: "index", parts: fkColumns.join(","), comment: "", invisible: false, definition: `INDEX ${quoteIdent(n)} (${fkColumns.map(quoteIdent).join(",")})` });
    }
    const action = (a: string | undefined) => (a === undefined || a === "NO ACTION" ? "RESTRICT" : a);
    const onDelete = action(f.onDelete);
    const onUpdate = action(f.onUpdate);
    return {
      name: fkName,
      columns: fkColumns.join(","),
      references: `${target.database}.${target.name}`,
      refColumns: refColumns.join(","),
      onDelete,
      onUpdate,
      definition: `CONSTRAINT ${quoteIdent(fkName)} FOREIGN KEY (${fkColumns.map(quoteIdent).join(",")}) REFERENCES ${quoteIdent(target.database)}.${quoteIdent(target.name)} (${refColumns.map(quoteIdent).join(",")}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
    };
  });

  let chkN = 0;
  const checks: CanonicalCheck[] = node.checks.map((c) => {
    const checkName = c.name ?? `${name}_chk_${++chkN}`;
    return {
      name: checkName,
      expr: normalizeExpression(sigOf(tokens, c.expr)),
      enforced: c.enforced,
      definition: `CONSTRAINT ${quoteIdent(checkName)} CHECK (${raw(tokens, c.expr) ?? ""})${c.enforced ? "" : " NOT ENFORCED"}`,
    };
  });

  const known = new Set(["ENGINE", "CHARSET", "COLLATE", "COMMENT", "ROW_FORMAT", "AUTO_INCREMENT"]);
  const options = Object.fromEntries(node.options.filter((o) => !known.has(o.key)).map((o) => [o.key, stringValue(raw(tokens, o.value) ?? "")]));
  const engine = option(node.options, "ENGINE");
  const rowFormat = option(node.options, "ROW_FORMAT");
  return {
    kind: "table",
    database,
    name,
    columns,
    ...(primaryKey !== undefined ? { primaryKey } : {}),
    ...(primaryKeySql !== undefined ? { primaryKeySql } : {}),
    indexes,
    foreignKeys,
    checks,
    ...(engine ? { engine: engineName(engine) } : {}),
    ...(charset ? { charset } : {}),
    ...(collate ? { collate } : {}),
    comment: stripMarker(rawComment),
    ...(rawComment ? { rawComment } : {}),
    ...(rowFormat ? { rowFormat: rowFormat.toUpperCase() } : {}),
    options,
  };
}

function canonicalColumn(c: ColumnNode, tokens: readonly Token[], inPrimaryKey: boolean, tableCharset: string | undefined, tableCollate: string | undefined): CanonicalColumn {
  const type = normalizeType(c.type.name, tokens.slice(c.type.span.from, c.type.span.to));
  const charset = charsetName(c.charset);
  const collate = charsetName(c.collate);
  const family = COLUMN_TYPES[c.type.name as keyof typeof COLUMN_TYPES]?.family;
  const textual = family === "character" || family === "text" || family === "enumeration";
  return {
    name: c.name,
    type,
    nullable: inPrimaryKey ? false : c.nullable ?? true,
    ...(() => {
      const d = normalizeDefault(type, sigOf(tokens, c.default));
      return d !== undefined ? { default: d, defaultSql: raw(tokens, c.default) ?? d } : {};
    })(),
    ...(c.onUpdate ? { onUpdate: currentTimestamp(sigOf(tokens, c.onUpdate)) ?? normalizeExpression(sigOf(tokens, c.onUpdate)) } : {}),
    autoIncrement: c.autoIncrement === true,
    ...(c.generated ? { generated: `${normalizeExpression(sigOf(tokens, c.generated.expr))} ${c.generated.stored ? "STORED" : "VIRTUAL"}` } : {}),
    ...(textual && charset && charset !== tableCharset ? { charset } : {}),
    ...(textual && collate && collate !== tableCollate ? { collate } : {}),
    comment: c.comment ?? "",
    invisible: c.invisible === true,
    ...(c.srid ? { srid: c.srid } : {}),
    definition: columnDefinition(c, tokens, inPrimaryKey),
  };
}

/** A column's definition as SQL, from what was written: its keys and checks left out, since those are the table's. */
function columnDefinition(c: ColumnNode, tokens: readonly Token[], inPrimaryKey: boolean): string {
  const r = (span: Span | undefined) => raw(tokens, span);
  return [
    quoteIdent(c.name),
    r(c.type.span) ?? "",
    c.charset ? `CHARACTER SET ${c.charset}` : "",
    c.collate ? `COLLATE ${c.collate}` : "",
    c.generated ? `GENERATED ALWAYS AS (${r(c.generated.expr) ?? ""}) ${c.generated.stored ? "STORED" : "VIRTUAL"}` : "",
    inPrimaryKey || c.nullable === false ? "NOT NULL" : c.nullable === true ? "NULL" : "",
    c.default ? `DEFAULT ${r(c.default)}` : "",
    c.onUpdate ? `ON UPDATE ${r(c.onUpdate)}` : "",
    c.autoIncrement ? "AUTO_INCREMENT" : "",
    c.comment ? `COMMENT ${mysqlString(c.comment)}` : "",
    c.invisible ? "INVISIBLE" : "",
    c.srid ? `SRID ${c.srid}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}
