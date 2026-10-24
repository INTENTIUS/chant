/**
 * T-SQL DDL into a syntax tree: `CREATE TABLE`, `CREATE [UNIQUE] [CLUSTERED |
 * NONCLUSTERED] INDEX`, `CREATE [CLUSTERED | NONCLUSTERED] COLUMNSTORE
 * INDEX ... [ORDER (...)]`, `CREATE VIEW`, `CREATE SCHEMA`, `ALTER TABLE ...
 * ADD CONSTRAINT`, and `sp_addextendedproperty` descriptions.
 *
 * Grammar sources (Microsoft Learn, Transact-SQL reference):
 * - CREATE TABLE: https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql
 * - CREATE INDEX: https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql
 * - CREATE COLUMNSTORE INDEX (the `ORDER (column [, ...n])` clause, which the
 *   SQL Server grammar places before or after `WITH`):
 *   https://learn.microsoft.com/en-us/sql/t-sql/statements/create-columnstore-index-transact-sql
 *
 * Every statement that is not one of these comes back as `refused` (a kind of
 * object this source cannot read, named: `trigger [dbo].[trg_audit]`) or
 * `ignored` (a session setting or a `DROP`, which declares nothing). Nothing
 * is dropped without being returned.
 */

import { batches, tokenize, upper, sourceOf, type Token } from "./lexer";

export interface Loc {
  line: number;
  column: number;
}

/** A multi-part name, unquoted: `[Sales].[Orders]` is `["Sales", "Orders"]`. */
export interface QName {
  parts: string[];
  loc: Loc;
}

export interface KeyColumn {
  name: string;
  descending: boolean;
}

export type ConstraintKind = "primary-key" | "unique" | "foreign-key" | "check" | "default";

export interface ConstraintAst {
  kind: ConstraintKind;
  name?: string;
  /** `CLUSTERED` or `NONCLUSTERED` when written. */
  clustered?: boolean;
  columns: KeyColumn[];
  references?: { table: QName; columns: string[] };
  /** A check's or a default's expression, as written (outer parentheses kept). */
  expression?: string;
  expressionTokens?: Token[];
  /** The column a column-level constraint was written on; the default's column. */
  onColumn?: string;
  /** `WITH (...)` or `ON ...` text after the key, which the translation names but does not carry. */
  options: string[];
  loc: Loc;
}

export interface ColumnAst {
  name: string;
  loc: Loc;
  /** Lower-cased type name; `sysname` and alias types appear as written. */
  type?: string;
  /** Qualified type (`[dbo].[Flag]`) when the name has a schema. */
  typeSchema?: string;
  /** `max` is `"max"`. */
  typeArgs: Array<number | "max">;
  nullable?: boolean;
  identity?: { seed: string; increment: string };
  /** `AS (expr) [PERSISTED]` and no type. */
  computed?: { expression: string; persisted: boolean };
  /** `GENERATED ALWAYS AS ROW START | END | TRANSACTION_ID_* ...` as written. */
  generated?: string;
  collate?: string;
  rowguid: boolean;
  sparse: boolean;
  /** Other column options carried as text and named in the review: `MASKED WITH`, `ENCRYPTED WITH`, `FILESTREAM`, `NOT FOR REPLICATION`. */
  extras: string[];
}

export interface TableAst {
  kind: "table";
  name: QName;
  columns: ColumnAst[];
  constraints: ConstraintAst[];
  /** `INDEX name [UNIQUE] [CLUSTERED|NONCLUSTERED] (cols)` inside the table. */
  indexes: IndexAst[];
  /** `PERIOD FOR SYSTEM_TIME (a, b)`. */
  period?: { start: string; end: string };
  /** Text of each clause after the column list: `WITH (...)`, `ON [PRIMARY]`, `TEXTIMAGE_ON ...`. */
  options: string[];
  /** `AS FileTable` / `AS NODE` / `AS EDGE`. */
  asKind?: string;
  loc: Loc;
}

export interface IndexAst {
  kind: "index";
  name: string;
  /** Absent for an index written inside `CREATE TABLE`. */
  table?: QName;
  unique: boolean;
  clustered: boolean;
  columnstore: boolean;
  columns: KeyColumn[];
  include: string[];
  /** The columnstore `ORDER (...)` columns. */
  order: string[];
  where?: string;
  options: string[];
  loc: Loc;
}

export interface ViewAst {
  kind: "view";
  name: QName;
  columns: string[];
  /** `WITH SCHEMABINDING, ...` */
  options: string[];
  /** The SELECT, as written, without the trailing `;`. */
  body: string;
  bodyTokens: Token[];
  loc: Loc;
}

export interface SchemaAst {
  kind: "schema";
  name: string;
  loc: Loc;
}

export interface AlterConstraintAst {
  kind: "alter-constraint";
  table: QName;
  constraint: ConstraintAst;
  loc: Loc;
}

export interface ExtendedPropertyAst {
  kind: "extended-property";
  /** `description` or the property's name. */
  property: string;
  value: string;
  schema?: string;
  table?: string;
  column?: string;
  /** `INDEX`, `CONSTRAINT`, `VIEW`, ... when level 2 is not a column. */
  level2?: { type: string; name: string };
  level1Type?: string;
  loc: Loc;
}

export interface RefusedAst {
  kind: "refused";
  /** `trigger`, `procedure`, `function`, ... */
  objectKind: string;
  name: string;
  reason: string;
  loc: Loc;
}

export interface IgnoredAst {
  kind: "ignored";
  /** What the statement was, e.g. `SET ANSI_NULLS ON`. */
  text: string;
  reason: string;
  loc: Loc;
}

export type StatementAst = TableAst | IndexAst | ViewAst | SchemaAst | AlterConstraintAst | ExtendedPropertyAst | RefusedAst | IgnoredAst;

export class TsqlParseError extends Error {
  constructor(
    message: string,
    readonly loc: Loc,
  ) {
    super(message);
    this.name = "TsqlParseError";
  }
}

const loc = (t: Token): Loc => ({ line: t.line, column: t.column });

/** A statement that began and could not be read: its first words, and why. */
export interface UnreadStatement {
  text: string;
  reason: string;
  loc: Loc;
}

export interface ParseResult {
  statements: StatementAst[];
  /** Statements that begin like one this source reads and are malformed or use syntax it does not read. */
  unread: UnreadStatement[];
}

// --- statement boundaries --------------------------------------------------

const START_WORDS = new Set("CREATE ALTER DROP EXEC EXECUTE SET USE INSERT UPDATE DELETE DECLARE PRINT IF GRANT DENY REVOKE SELECT BEGIN TRUNCATE MERGE RETURN WHILE".split(" "));
/** Statements that own the rest of their batch: a body can hold any statement word. */
const BATCH_BODY = new Set(["VIEW", "PROC", "PROCEDURE", "FUNCTION", "TRIGGER"]);

/** Split one batch into statements: at `;`, and where a new statement word starts at depth 0. */
function statementsOf(batch: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  let ownsBatch = false;
  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
    depth = 0;
    ownsBatch = false;
  };
  for (let k = 0; k < batch.length; k++) {
    const t = batch[k]!;
    if (t.kind === "punct" && t.value === ";" && depth === 0 && !ownsBatch) {
      flush();
      continue;
    }
    if (t.kind === "punct" && t.value === "(") depth++;
    if (t.kind === "punct" && t.value === ")") depth = Math.max(0, depth - 1);
    const w = upper(t);
    const prev = upper(cur[cur.length - 1]);
    if (cur.length > 0 && depth === 0 && !ownsBatch && START_WORDS.has(w)) {
      const guarded = prev === "ON" || prev === "OR" || prev === "DELETE" || prev === "UPDATE" || (w === "SET" && batch[k + 1]?.value === "(") || (w === "IF" && upper(cur[0]) === "DROP");
      // `DROP INDEX IF EXISTS`, `ON DELETE SET NULL` and `ALTER TABLE ... SET (...)` keep going.
      if (!guarded) flush();
    }
    cur.push(t);
    if (cur.length === 2 || cur.length === 3 || cur.length === 4) {
      // `CREATE [OR ALTER] VIEW`: the body runs to the end of the batch.
      const words = cur.map(upper);
      if (words[0] === "CREATE" || words[0] === "ALTER") {
        const kind = words[1] === "OR" ? words[3] : words[1];
        if (BATCH_BODY.has(kind ?? "") && (words[1] !== "OR" || cur.length === 4)) ownsBatch = true;
      }
    }
  }
  flush();
  return out;
}

// --- cursor ------------------------------------------------------------------

class Cursor {
  i = 0;
  constructor(readonly tokens: readonly Token[]) {}
  get done(): boolean {
    return this.i >= this.tokens.length;
  }
  peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  next(): Token {
    const t = this.tokens[this.i++];
    if (!t) throw new TsqlParseError("the statement ends early", this.tokens.length > 0 ? loc(this.tokens[this.tokens.length - 1]!) : { line: 1, column: 1 });
    return t;
  }
  isWord(...words: string[]): boolean {
    return words.includes(upper(this.peek()));
  }
  /** Consume the next token when it is one of `words`. */
  eat(...words: string[]): Token | undefined {
    return this.isWord(...words) ? this.next() : undefined;
  }
  eatPunct(p: string): boolean {
    const t = this.peek();
    if (t && t.kind === "punct" && t.value === p) {
      this.i++;
      return true;
    }
    return false;
  }
  expectWord(...words: string[]): Token {
    const t = this.peek();
    if (!this.isWord(...words)) throw new TsqlParseError(`expected ${words.join(" or ")}, found ${t ? `"${t.text}"` : "the end of the statement"}`, t ? loc(t) : { line: 1, column: 1 });
    return this.next();
  }
  expectPunct(p: string): void {
    const t = this.peek();
    if (!this.eatPunct(p)) throw new TsqlParseError(`expected "${p}", found ${t ? `"${t.text}"` : "the end of the statement"}`, t ? loc(t) : { line: 1, column: 1 });
  }
  /** Tokens inside a balanced `( ... )`, which the cursor is at. */
  group(): Token[] {
    this.expectPunct("(");
    const start = this.i;
    let depth = 1;
    while (!this.done) {
      const t = this.next();
      if (t.kind === "punct" && t.value === "(") depth++;
      if (t.kind === "punct" && t.value === ")" && --depth === 0) return this.tokens.slice(start, this.i - 1) as Token[];
    }
    throw new TsqlParseError('a "(" is never closed', loc(this.tokens[start - 1]!));
  }
}

/** Split tokens at depth-0 commas. */
function splitCommas(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct" && t.value === "(") depth++;
    if (t.kind === "punct" && t.value === ")") depth--;
    if (depth === 0 && t.kind === "punct" && t.value === ",") {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function qname(c: Cursor): QName {
  const first = c.peek();
  if (!first || (first.kind !== "word" && first.kind !== "qident")) throw new TsqlParseError(`expected a name, found ${first ? `"${first.text}"` : "the end of the statement"}`, first ? loc(first) : { line: 1, column: 1 });
  const parts: string[] = [];
  for (;;) {
    const t = c.next();
    parts.push(t.value);
    const dot = c.peek();
    if (dot && dot.kind === "punct" && dot.value === ".") {
      c.i++;
      // `db..table` has an empty schema part.
      const after = c.peek();
      if (after && after.kind === "punct" && after.value === ".") {
        c.i++;
        parts.push("dbo");
      }
      continue;
    }
    break;
  }
  return { parts, loc: loc(first) };
}

function keyColumns(tokens: readonly Token[]): KeyColumn[] {
  return splitCommas(tokens).map((part) => {
    const c = new Cursor(part);
    const name = c.next();
    let descending = false;
    if (c.eat("DESC")) descending = true;
    else c.eat("ASC");
    return { name: name.value, descending };
  });
}

const nameList = (tokens: readonly Token[]): string[] => splitCommas(tokens).map((p) => p[0]!.value);

// --- constraints ---------------------------------------------------------------

/** Text of a `WITH (...)` / `ON x` tail on a key, so the translation can name it. */
function keyOptions(c: Cursor, text: string): string[] {
  const out: string[] = [];
  for (;;) {
    if (c.isWord("WITH") && c.peek(1)?.value === "(") {
      const start = c.i;
      c.next();
      c.group();
      out.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else if (c.isWord("ON") && c.peek(1) && !["DELETE", "UPDATE"].includes(upper(c.peek(1)))) {
      const start = c.i;
      c.next();
      qname(c);
      if (c.peek()?.value === "(") c.group();
      out.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else break;
  }
  return out;
}

/**
 * One constraint, with the cursor at `PRIMARY`, `UNIQUE`, `FOREIGN`, `CHECK`,
 * `DEFAULT` or `REFERENCES` (a column-level foreign key). `onColumn` is the
 * column a column-level constraint was written on.
 */
function constraint(c: Cursor, text: string, name: string | undefined, onColumn: string | undefined, startTok: Token): ConstraintAst {
  const base = { name, onColumn, options: [] as string[], loc: loc(startTok) };
  if (c.eat("PRIMARY")) {
    c.expectWord("KEY");
    const clustered = c.eat("CLUSTERED", "NONCLUSTERED");
    const columns = c.peek()?.value === "(" ? keyColumns(c.group()) : onColumn ? [{ name: onColumn, descending: false }] : [];
    c.eat("HASH");
    const options = keyOptions(c, text);
    return { ...base, kind: "primary-key", clustered: clustered ? upper(clustered) === "CLUSTERED" : undefined, columns, options };
  }
  if (c.eat("UNIQUE")) {
    const clustered = c.eat("CLUSTERED", "NONCLUSTERED");
    const columns = c.peek()?.value === "(" ? keyColumns(c.group()) : onColumn ? [{ name: onColumn, descending: false }] : [];
    const options = keyOptions(c, text);
    return { ...base, kind: "unique", clustered: clustered ? upper(clustered) === "CLUSTERED" : undefined, columns, options };
  }
  if (c.eat("FOREIGN")) {
    c.expectWord("KEY");
    const columns = keyColumns(c.group());
    c.expectWord("REFERENCES");
    return { ...referenceTail(c, text, base), columns };
  }
  if (c.isWord("REFERENCES")) {
    c.next();
    return { ...referenceTail(c, text, base), columns: onColumn ? [{ name: onColumn, descending: false }] : [] };
  }
  if (c.eat("CHECK")) {
    const notForReplication = c.isWord("NOT") && c.peek(1)?.value.toUpperCase() === "FOR";
    if (notForReplication) {
      c.next();
      c.next();
      c.next();
    }
    const startIdx = c.i;
    const inner = c.group();
    return { ...base, kind: "check", columns: onColumn ? [{ name: onColumn, descending: false }] : [], expression: sourceOf(text, c.tokens.slice(startIdx, c.i)), expressionTokens: inner };
  }
  if (c.eat("DEFAULT")) {
    const { tokens, source } = defaultExpression(c, text);
    return { ...base, kind: "default", columns: onColumn ? [{ name: onColumn, descending: false }] : [], expression: source, expressionTokens: tokens };
  }
  const t = c.peek();
  throw new TsqlParseError(`a constraint this source does not read: "${t?.text ?? ""}"`, t ? loc(t) : base.loc);
}

function referenceTail(c: Cursor, text: string, base: { name: string | undefined; onColumn: string | undefined; options: string[]; loc: Loc }): Omit<ConstraintAst, "columns"> {
  const table = qname(c);
  const columns = c.peek()?.value === "(" ? nameList(c.group()) : [];
  // ON DELETE | ON UPDATE actions, NOT FOR REPLICATION
  const actions: string[] = [];
  for (;;) {
    if (c.isWord("ON") && ["DELETE", "UPDATE"].includes(c.peek(1)?.value.toUpperCase() ?? "")) {
      const start = c.i;
      c.next();
      c.next();
      if (c.eat("NO")) c.expectWord("ACTION");
      else if (c.eat("SET")) c.expectWord("NULL", "DEFAULT");
      else c.expectWord("CASCADE");
      actions.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else if (c.isWord("NOT") && c.peek(1)?.value.toUpperCase() === "FOR") {
      c.next();
      c.next();
      c.next();
    } else break;
  }
  return { ...base, kind: "foreign-key", references: { table, columns }, options: actions };
}

/** A default's expression: a parenthesised group, or a signed literal / function call. */
function defaultExpression(c: Cursor, text: string): { tokens: Token[]; source: string } {
  const start = c.i;
  if (c.peek()?.value === "(") {
    const inner = c.group();
    return { tokens: inner, source: sourceOf(text, c.tokens.slice(start, c.i)) };
  }
  const sign = c.peek();
  if (sign && sign.kind === "punct" && (sign.value === "-" || sign.value === "+")) c.next();
  const t = c.next();
  if (t.kind === "word" && c.peek()?.value === "(") c.group();
  const slice = c.tokens.slice(start, c.i);
  return { tokens: slice as Token[], source: sourceOf(text, slice) };
}

// --- CREATE TABLE ----------------------------------------------------------------

const TABLE_LEVEL_START = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "INDEX", "PERIOD", "CONNECTION"]);

function columnDef(tokens: readonly Token[], text: string, constraints: ConstraintAst[]): ColumnAst {
  const c = new Cursor(tokens);
  const nameTok = c.next();
  const col: ColumnAst = { name: nameTok.value, loc: loc(nameTok), typeArgs: [], rowguid: false, sparse: false, extras: [] };
  if (c.isWord("AS")) {
    c.next();
    const startIdx = c.i;
    // `AS (expr)` or `AS expr` up to PERSISTED / NOT NULL / a constraint word
    let expr: Token[];
    if (c.peek()?.value === "(") {
      c.group();
      expr = c.tokens.slice(startIdx, c.i) as Token[];
    } else {
      while (!c.done && !c.isWord("PERSISTED", "NOT", "NULL", "CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "REFERENCES")) c.next();
      expr = c.tokens.slice(startIdx, c.i) as Token[];
    }
    col.computed = { expression: sourceOf(text, expr), persisted: false };
  } else {
    // The type: `[schema].]name [(args)]`
    const first = c.next();
    let typeTok = first;
    if (c.peek()?.value === "." && c.peek()?.kind === "punct") {
      c.next();
      col.typeSchema = first.value;
      typeTok = c.next();
    }
    col.type = typeTok.value.toLowerCase();
    if (c.peek()?.value === "(" && c.peek()?.kind === "punct") {
      for (const arg of splitCommas(c.group())) {
        const t = arg[0];
        if (t && t.kind === "number") col.typeArgs.push(Number(t.value));
        else if (t && upper(t) === "MAX") col.typeArgs.push("max");
        else throw new TsqlParseError(`a type argument this source does not read: "${arg.map((x) => x.text).join(" ")}"`, t ? loc(t) : col.loc);
      }
    }
  }
  let constraintName: string | undefined;
  while (!c.done) {
    const t = c.peek()!;
    const w = upper(t);
    if (w === "CONSTRAINT") {
      c.next();
      constraintName = c.next().value;
      continue;
    }
    if (w === "COLLATE") {
      c.next();
      col.collate = c.next().value;
    } else if (w === "NOT" && upper(c.peek(1)) === "NULL") {
      c.next();
      c.next();
      col.nullable = false;
    } else if (w === "NULL") {
      c.next();
      col.nullable = true;
    } else if (w === "NOT" && upper(c.peek(1)) === "FOR") {
      c.next();
      c.next();
      c.next();
      col.extras.push("NOT FOR REPLICATION");
    } else if (w === "IDENTITY") {
      c.next();
      if (c.peek()?.value === "(") {
        const args = splitCommas(c.group());
        col.identity = { seed: args[0]?.map((x) => x.text).join("") ?? "1", increment: args[1]?.map((x) => x.text).join("") ?? "1" };
      } else col.identity = { seed: "1", increment: "1" };
    } else if (w === "GENERATED") {
      const start = c.i;
      c.next();
      c.expectWord("ALWAYS");
      c.expectWord("AS");
      while (!c.done && !c.isWord("NOT", "NULL", "HIDDEN", "CONSTRAINT")) c.next();
      col.generated = sourceOf(text, c.tokens.slice(start, c.i));
      if (c.eat("HIDDEN")) col.generated += " HIDDEN";
    } else if (w === "PERSISTED" && col.computed) {
      c.next();
      col.computed.persisted = true;
    } else if (w === "ROWGUIDCOL") {
      c.next();
      col.rowguid = true;
    } else if (w === "SPARSE") {
      c.next();
      col.sparse = true;
    } else if (w === "FILESTREAM") {
      c.next();
      col.extras.push("FILESTREAM");
    } else if (w === "MASKED" || w === "ENCRYPTED") {
      const start = c.i;
      c.next();
      c.expectWord("WITH");
      c.group();
      col.extras.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else if (w === "DEFAULT" || w === "PRIMARY" || w === "UNIQUE" || w === "CHECK" || w === "REFERENCES" || w === "FOREIGN") {
      constraints.push(constraint(c, text, constraintName, col.name, t));
      constraintName = undefined;
    } else {
      throw new TsqlParseError(`a column option this source does not read: "${t.text}" on column ${col.name}`, loc(t));
    }
  }
  return col;
}

function tableBody(c: Cursor, text: string, nameTok: Token, name: QName): TableAst {
  const table: TableAst = { kind: "table", name, columns: [], constraints: [], indexes: [], options: [], loc: loc(nameTok) };
  if (c.isWord("AS")) {
    // AS FileTable | AS NODE | AS EDGE
    c.next();
    table.asKind = c.next().value.toUpperCase();
  }
  const items = splitCommas(c.group());
  for (const item of items) {
    const ic = new Cursor(item);
    const w = upper(ic.peek());
    // A column may be named like a table-level keyword when bracketed; only a bare word starts one.
    if (ic.peek()?.kind === "word" && TABLE_LEVEL_START.has(w)) {
      if (w === "CONSTRAINT") {
        const startTok = ic.next();
        const cname = ic.next().value;
        table.constraints.push(constraint(ic, text, cname, undefined, startTok));
      } else if (w === "INDEX") {
        ic.next();
        const nameTok2 = ic.next();
        const idx: IndexAst = { kind: "index", name: nameTok2.value, unique: false, clustered: false, columnstore: false, columns: [], include: [], order: [], options: [], loc: loc(nameTok2) };
        if (ic.eat("UNIQUE")) idx.unique = true;
        const cl = ic.eat("CLUSTERED", "NONCLUSTERED");
        if (cl) idx.clustered = upper(cl) === "CLUSTERED";
        if (ic.eat("COLUMNSTORE")) idx.columnstore = true;
        if (ic.peek()?.value === "(") idx.columns = keyColumns(ic.group());
        if (ic.eat("INCLUDE")) idx.include = nameList(ic.group());
        if (ic.eat("WHERE")) {
          const start = ic.i;
          while (!ic.done && !ic.isWord("WITH", "ON")) ic.next();
          idx.where = sourceOf(text, ic.tokens.slice(start, ic.i));
        }
        idx.options = keyOptions(ic, text);
        table.indexes.push(idx);
      } else if (w === "PERIOD") {
        ic.next();
        ic.expectWord("FOR");
        ic.expectWord("SYSTEM_TIME");
        const cols = nameList(ic.group());
        table.period = { start: cols[0] ?? "", end: cols[1] ?? "" };
      } else if (w === "CONNECTION") {
        throw new TsqlParseError("an edge-table CONNECTION constraint, which this source does not read", loc(ic.peek()!));
      } else {
        table.constraints.push(constraint(ic, text, undefined, undefined, ic.peek()!));
      }
      if (!ic.done) throw new TsqlParseError(`text this source does not read after a table constraint: "${ic.peek()!.text}"`, loc(ic.peek()!));
    } else {
      table.columns.push(columnDef(item, text, table.constraints));
    }
  }
  // `WITH (...)`, `ON [PRIMARY]`, `TEXTIMAGE_ON x`, `FILESTREAM_ON x`, `LEDGER = ON`
  while (!c.done) {
    const start = c.i;
    const t = c.next();
    const w = upper(t);
    if (w === "WITH" && c.peek()?.value === "(") c.group();
    else if (w === "ON") {
      qname(c);
      if (c.peek()?.value === "(") c.group();
    } else if (w === "TEXTIMAGE_ON" || w === "FILESTREAM_ON") qname(c);
    else throw new TsqlParseError(`a table clause this source does not read: "${t.text}"`, loc(t));
    table.options.push(sourceOf(text, c.tokens.slice(start, c.i)));
  }
  return table;
}

// --- CREATE INDEX ----------------------------------------------------------------

function indexStatement(c: Cursor, text: string, startTok: Token): IndexAst {
  let unique = false;
  let clustered = false;
  let columnstore = false;
  if (c.eat("UNIQUE")) unique = true;
  const cl = c.eat("CLUSTERED", "NONCLUSTERED");
  if (cl) clustered = upper(cl) === "CLUSTERED";
  if (c.eat("COLUMNSTORE")) columnstore = true;
  c.expectWord("INDEX");
  const nameTok = c.next();
  c.expectWord("ON");
  const table = qname(c);
  const idx: IndexAst = { kind: "index", name: nameTok.value, table, unique, clustered, columnstore, columns: [], include: [], order: [], options: [], loc: loc(startTok) };
  if (c.peek()?.value === "(") idx.columns = keyColumns(c.group());
  // Clauses may come in more than one order: ORDER before or after WITH.
  while (!c.done) {
    if (c.eat("INCLUDE")) idx.include = nameList(c.group());
    else if (c.eat("ORDER")) idx.order = nameList(c.group());
    else if (c.eat("WHERE")) {
      const start = c.i;
      while (!c.done && !c.isWord("WITH", "ON", "ORDER")) c.next();
      idx.where = sourceOf(text, c.tokens.slice(start, c.i));
    } else if (c.isWord("WITH") && c.peek(1)?.value === "(") {
      const start = c.i;
      c.next();
      c.group();
      idx.options.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else if (c.isWord("ON")) {
      const start = c.i;
      c.next();
      qname(c);
      if (c.peek()?.value === "(") c.group();
      idx.options.push(sourceOf(text, c.tokens.slice(start, c.i)));
    } else {
      const t = c.peek()!;
      throw new TsqlParseError(`an index clause this source does not read: "${t.text}"`, loc(t));
    }
  }
  return idx;
}

// --- the rest ------------------------------------------------------------------------

const REFUSED_KINDS: Record<string, { kind: string; reason: string }> = {
  TRIGGER: { kind: "trigger", reason: "a trigger runs T-SQL on writes; ClickHouse has no trigger, and its closest match is a materialized view" },
  PROC: { kind: "procedure", reason: "a stored procedure is T-SQL code; ClickHouse has no stored procedures" },
  PROCEDURE: { kind: "procedure", reason: "a stored procedure is T-SQL code; ClickHouse has no stored procedures" },
  FUNCTION: { kind: "function", reason: "a T-SQL function is code this source does not translate; a ClickHouse user-defined function is a lambda expression" },
  SEQUENCE: { kind: "sequence", reason: "ClickHouse has no sequence object" },
  TYPE: { kind: "type", reason: "a user-defined type has no ClickHouse counterpart" },
  SYNONYM: { kind: "synonym", reason: "ClickHouse has no synonym" },
  ROLE: { kind: "role", reason: "access control is not read by this source" },
  USER: { kind: "user", reason: "access control is not read by this source" },
  LOGIN: { kind: "login", reason: "access control is not read by this source" },
  DATABASE: { kind: "database", reason: "a database is created outside the schema file" },
  STATISTICS: { kind: "statistics", reason: "ClickHouse keeps no user-created statistics" },
  PARTITION: { kind: "partition function or scheme", reason: "ClickHouse partitions with PARTITION BY on the table" },
  XML: { kind: "xml schema collection", reason: "ClickHouse has no XML schema collection" },
  ASSEMBLY: { kind: "assembly", reason: "a CLR assembly is not portable" },
  AGGREGATE: { kind: "aggregate", reason: "a CLR aggregate is not portable" },
  RULE: { kind: "rule", reason: "ClickHouse has no rule object" },
  DEFAULT: { kind: "default object", reason: "ClickHouse has no default object" },
  EVENT: { kind: "event session or notification", reason: "not read by this source" },
  FULLTEXT: { kind: "full-text object", reason: "ClickHouse has no full-text catalog" },
  SEARCH: { kind: "search property list", reason: "not read by this source" },
  MASTER: { kind: "master key", reason: "key management is not read by this source" },
  CERTIFICATE: { kind: "certificate", reason: "key management is not read by this source" },
  EXTERNAL: { kind: "external object", reason: "not read by this source" },
  MATERIALIZED: { kind: "materialized view", reason: "not read by this source" },
  SECURITY: { kind: "security policy", reason: "row-level security is not read by this source" },
  QUEUE: { kind: "service broker object", reason: "ClickHouse has no service broker" },
};

function describeStatement(tokens: readonly Token[], text: string): string {
  const shown = tokens.slice(0, 8);
  return sourceOf(text, shown).replace(/\s+/g, " ");
}

function oneStatement(tokens: readonly Token[], text: string, out: ParseResult): void {
  const c = new Cursor(tokens);
  const first = c.peek()!;
  const start = loc(first);
  const w = upper(first);
  try {
    if (w === "CREATE" || w === "ALTER") {
      c.next();
      if (w === "CREATE" && c.isWord("OR")) {
        c.next();
        c.expectWord("ALTER");
      }
      const kind = upper(c.peek());
      if (w === "CREATE" && kind === "TABLE") {
        c.next();
        const nameTok = c.peek()!;
        const name = qname(c);
        out.statements.push(tableBody(c, text, nameTok, name));
        return;
      }
      if (w === "CREATE" && (kind === "INDEX" || kind === "UNIQUE" || kind === "CLUSTERED" || kind === "NONCLUSTERED" || kind === "COLUMNSTORE")) {
        out.statements.push(indexStatement(c, text, first));
        return;
      }
      if (w === "CREATE" && kind === "VIEW") {
        c.next();
        const name = qname(c);
        const columns = c.peek()?.value === "(" ? nameList(c.group()) : [];
        const options: string[] = [];
        if (c.eat("WITH")) {
          for (const part of splitCommas(tokens.slice(c.i))) options.push(sourceOf(text, part));
          while (!c.isWord("AS")) c.next();
        }
        c.expectWord("AS");
        let body = tokens.slice(c.i);
        while (body.length > 0 && body[body.length - 1]!.kind === "punct" && body[body.length - 1]!.value === ";") body = body.slice(0, -1);
        out.statements.push({ kind: "view", name, columns, options, body: sourceOf(text, body), bodyTokens: [...body], loc: name.loc });
        return;
      }
      if (w === "CREATE" && kind === "SCHEMA") {
        c.next();
        out.statements.push({ kind: "schema", name: c.next().value, loc: start });
        return;
      }
      if (w === "CREATE" || (w === "ALTER" && kind !== "TABLE")) {
        const refused = REFUSED_KINDS[kind];
        const objectKind = refused?.kind ?? kind.toLowerCase();
        c.next();
        // `PARTITION FUNCTION f`, `XML SCHEMA COLLECTION c`, `EXTERNAL TABLE t`: skip the second word.
        if (["PARTITION", "XML", "EXTERNAL", "EVENT", "FULLTEXT", "SEARCH", "MASTER", "SECURITY", "MATERIALIZED"].includes(kind)) {
          const second = c.peek();
          if (second && second.kind === "word") c.next();
        }
        const nameTok = c.peek();
        let name = "";
        if (nameTok && (nameTok.kind === "word" || nameTok.kind === "qident")) name = qname(c).parts.join(".");
        out.statements.push({
          kind: "refused",
          objectKind: w === "ALTER" ? `alter ${objectKind}` : objectKind,
          name,
          reason: refused?.reason ?? "a kind of object this source does not read",
          loc: start,
        });
        return;
      }
      // ALTER TABLE t [WITH [NO]CHECK] ADD [CONSTRAINT n] ...
      c.expectWord("TABLE");
      const table = qname(c);
      if (c.eat("WITH")) c.expectWord("CHECK", "NOCHECK");
      if (c.isWord("ADD")) {
        c.next();
        let cname: string | undefined;
        const ctok = c.peek()!;
        if (c.eat("CONSTRAINT")) cname = c.next().value;
        if (c.isWord("PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "DEFAULT")) {
          const k = constraint(c, text, cname, undefined, ctok);
          // `ADD DEFAULT (x) FOR col`
          if (k.kind === "default" && c.eat("FOR")) k.columns = [{ name: c.next().value, descending: false }];
          if (!c.done) throw new TsqlParseError(`text this source does not read after the constraint: "${c.peek()!.text}"`, loc(c.peek()!));
          out.statements.push({ kind: "alter-constraint", table, constraint: k, loc: start });
          return;
        }
      }
      out.unread.push({ text: describeStatement(tokens, text), reason: "an ALTER TABLE this source does not read; only ADD CONSTRAINT is read", loc: start });
      return;
    }
    if (w === "EXEC" || w === "EXECUTE") {
      c.next();
      const proc = c.peek();
      if (proc && /^sp_addextendedproperty$/i.test(proc.value)) {
        const ep = extendedProperty(c, start);
        if (ep) {
          out.statements.push(ep);
          return;
        }
      }
      out.statements.push({ kind: "refused", objectKind: "statement", name: describeStatement(tokens, text), reason: "executing a procedure is code, not a declaration", loc: start });
      return;
    }
    if (w === "SET" || w === "USE" || w === "PRINT" || w === "DROP" || w === "DECLARE" || w === "RETURN" || w === "TRUNCATE") {
      const reason =
        w === "DROP"
          ? "a DROP is not a declaration; the schema describes the end state"
          : w === "SET" || w === "USE"
            ? "a session or connection setting, not a declaration"
            : "not a declaration";
      out.statements.push({ kind: "ignored", text: describeStatement(tokens, text), reason, loc: start });
      return;
    }
    out.statements.push({ kind: "refused", objectKind: "statement", name: describeStatement(tokens, text), reason: "this source reads CREATE TABLE, CREATE INDEX, CREATE VIEW, CREATE SCHEMA and ALTER TABLE ... ADD CONSTRAINT", loc: start });
  } catch (e) {
    if (e instanceof TsqlParseError) {
      out.unread.push({ text: describeStatement(tokens, text), reason: e.message, loc: e.loc });
      return;
    }
    throw e;
  }
}

/** `EXECUTE sp_addextendedproperty @name = N'...', @value = ..., @level0type = ..., ...`; undefined when it is not the shape SSDT writes. */
function extendedProperty(c: Cursor, at: Loc): ExtendedPropertyAst | undefined {
  c.next();
  const args = new Map<string, string>();
  const rest = c.tokens.slice(c.i);
  for (const part of splitCommas(rest)) {
    const t = part[0];
    if (!t || t.kind !== "variable" || part[1]?.value !== "=" || !part[2]) return undefined;
    const v = part[2];
    args.set(t.value.toLowerCase(), v.kind === "string" || v.kind === "qident" ? v.value : v.text);
  }
  const name = args.get("@name");
  const value = args.get("@value");
  if (name === undefined || value === undefined) return undefined;
  const l2t = args.get("@level2type");
  const l2n = args.get("@level2name");
  return {
    kind: "extended-property",
    property: name,
    value,
    schema: args.get("@level0name"),
    table: args.get("@level1name"),
    level1Type: args.get("@level1type"),
    ...(l2t?.toUpperCase() === "COLUMN" ? { column: l2n } : l2t && l2n ? { level2: { type: l2t, name: l2n } } : {}),
    loc: at,
  };
}

/** Parse a file of T-SQL. Lexing errors throw `TsqlLexError`. */
export function parseTsql(text: string): ParseResult {
  const out: ParseResult = { statements: [], unread: [] };
  for (const batch of batches(tokenize(text))) {
    for (const stmt of statementsOf(batch)) oneStatement(stmt, text, out);
  }
  return out;
}
