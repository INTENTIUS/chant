/**
 * The statements that make one classified change (#3208): a `CREATE` with
 * chant's marker in its comment, the `ALTER`s for the metadata and
 * background-rewrite classes, and the `DROP` a prune issues.
 *
 * Each function here takes a declared object and the changes the classifier
 * reported for it, and returns SQL; nothing is sent. The applier
 * (`./apply.ts`) sends them, and the rebuild migration (#3198) builds its new
 * table and swaps it in with the same pieces.
 *
 * The SQL is taken from the declaration's own text wherever it can be: a
 * column's definition, an index's expression, a TTL, a setting's value are
 * the spans the parser found in the declared `CREATE`, not the normalized
 * forms the classifier compared. The normalized form is for comparing; what
 * the server is sent is what the author wrote.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseCreate, type CreateNode, type Span, type TableNode, type ViewNode } from "../parser";
import { canonicalObject, type CanonicalObject } from "../plan/normalize";
import type { Change } from "../plan/diff";
import { CLASSIFIER_RULES } from "../plan/rules";
import { stampedComment } from "../ownership";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "../entities";

/** A backquoted identifier. */
export const ident = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** `database.name` backquoted, or a database's bare name. */
export const qualifiedIdent = (database: string | undefined, name: string): string =>
  database !== undefined ? `${ident(database)}.${ident(name)}` : ident(name);

/** A single-quoted string literal. */
export const sqlString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** `db.name` split at its first dot. */
export function splitQualified(name: string): { database?: string; name: string } {
  const at = name.indexOf(".");
  return at < 0 ? { name } : { database: name.slice(0, at), name: name.slice(at + 1) };
}

/** One object as a build declares it, in the shape the applier works with. */
export interface DeclaredObject {
  /** The export name: the object's identity in chant. */
  exportName: string;
  type: ClickHouseEntityType;
  /** `database.name` for a table or view, the name for a database: its identity on the server. */
  key: string;
  ddl: string;
  canonical: CanonicalObject;
  /** The export names this object references. */
  dependsOn: string[];
}

/** One statement to send, and whether it starts a background rewrite to wait on. */
export interface Step {
  sql: string;
  /** A mutation follows on the server; wait on `system.mutations` before the next step. */
  rewrite: boolean;
}

interface Parsed {
  tokens: Token[];
  node: CreateNode;
}

const parsedCache = new WeakMap<DeclaredObject, Parsed>();

function parsed(obj: DeclaredObject): Parsed {
  let p = parsedCache.get(obj);
  if (!p) {
    const tokens = tokenizeText(obj.ddl, 0);
    p = { tokens, node: parseCreate(tokens) };
    parsedCache.set(obj, p);
  }
  return p;
}

const text = (tokens: Token[], span: Span | undefined): string | undefined =>
  span && span.to > span.from
    ? tokens
        .slice(span.from, span.to)
        .map((t) => t.text)
        .join("")
        .trim()
    : undefined;

/** The object's name on the server, quoted. */
export const objectIdent = (obj: DeclaredObject): string => qualifiedIdent(obj.canonical.database, obj.canonical.name);

/** The statement's end, past its significant tokens: trailing whitespace, comments and a `;` left out. */
function statementBody(tokens: Token[]): string {
  let end = tokens.length;
  while (end > 0 && (isTrivia(tokens[end - 1]!) || tokens[end - 1]!.text === ";")) end--;
  return tokens
    .slice(0, end)
    .map((t) => t.text)
    .join("");
}

/**
 * The declared `CREATE` with chant's ownership marker in its comment: the
 * declared comment, if any, with the trailer after it, or a `COMMENT` clause
 * added at the end. Set in the `CREATE` itself, so no object is ever created
 * unmarked. `orReplace` turns `CREATE VIEW` into `CREATE OR REPLACE VIEW`;
 * `trailer` adds pairs to the marker (the rebuild migration's working
 * objects, `../rebuild/`).
 */
export function createStatement(
  obj: DeclaredObject,
  marker: OwnershipMarker | undefined,
  opts: { orReplace?: boolean; trailer?: Readonly<Record<string, string>> } = {},
): string {
  const { tokens, node } = parsed(obj);
  const literal = sqlString(stampedComment(obj.canonical.comment, marker, opts.trailer));
  let sql: string;
  if (node.comment) {
    sql =
      tokens
        .slice(0, node.comment.from)
        .map((t) => t.text)
        .join("") +
      literal +
      statementBody(tokens.slice(node.comment.to));
  } else {
    sql = `${statementBody(tokens)} COMMENT ${literal}`;
  }
  if (opts.orReplace && node.statement === "view" && !node.orReplace) {
    sql = sql.replace(/^(\s*(?:--[^\n]*\n\s*)*)CREATE\s+/i, "$1CREATE OR REPLACE ");
  }
  return sql;
}

/** Restamp the object's comment: the declared comment with this project's marker. */
export function commentStatement(obj: DeclaredObject, marker: OwnershipMarker | undefined): string {
  const literal = sqlString(stampedComment(obj.canonical.comment, marker));
  return obj.type === CLICKHOUSE_ENTITY_TYPES.database
    ? `ALTER DATABASE ${objectIdent(obj)} MODIFY COMMENT ${literal}`
    : `ALTER TABLE ${objectIdent(obj)} MODIFY COMMENT ${literal}`;
}

/** The `DROP` for an object a prune removes. `SYNC` so the name is free when it returns. */
export function dropStatement(type: string, database: string | undefined, name: string): string {
  if (type === CLICKHOUSE_ENTITY_TYPES.database) return `DROP DATABASE ${ident(name)} SYNC`;
  const what = type === CLICKHOUSE_ENTITY_TYPES.table ? "TABLE" : "VIEW";
  return `DROP ${what} ${qualifiedIdent(database, name)} SYNC`;
}

/** Changes a plan refuses to make in place: they run as the rebuild migration (#3198). */
export const isRebuild = (c: Change): boolean => c.class === "rebuild";

/** Changes that remove data from an object the build still declares: withheld unless the apply may delete. */
export const isDestructiveAlter = (c: Change): boolean => c.rule === "SQLCH202";

/**
 * A refused change in a sentence: the rule, the restriction, where it is
 * stated, and where the change goes instead: the rebuild migration Op for
 * the table (`key`, `database.name`), or for a view or database, which the
 * Op does not rebuild, a drop and a create.
 */
export function refusalDetail(changes: readonly Change[], key?: string, type?: string): string {
  const parts = changes.map((c) => {
    const rule = CLASSIFIER_RULES[c.rule];
    const values = c.before !== undefined || c.after !== undefined ? ` (${c.before ?? "none"} -> ${c.after ?? "none"})` : "";
    return `${c.rule} ${rule.title} on ${c.field}${values}: ${rule.restriction} ${rule.cite}`;
  });
  const instead =
    type === undefined || type === CLICKHOUSE_ENTITY_TYPES.table
      ? `Run it as the rebuild migration Op: ClickHouseRebuildOp({ table: ${JSON.stringify(key ?? "<database.table>")}, ... }) from @intentius/chant-lexicon-sql/clickhouse`
      : "The rebuild migration Op rebuilds tables only; drop and create this object instead";
  return `needs a rebuild, which ALTER cannot make: ${parts.join("; ")}. ${instead}`;
}

/**
 * The declaration under another name in the same database: the rebuild
 * migration creates its new table from the declared `CREATE` this way.
 */
export function renamedDeclaration(obj: DeclaredObject, name: string, defaultDatabase = "default"): DeclaredObject {
  const { tokens, node } = parsed(obj);
  if (node.statement === "database") throw new Error(`${obj.key}: a database is not renamed this way`);
  const ddl =
    tokens
      .slice(0, node.name.from)
      .map((t) => t.text)
      .join("") +
    qualifiedIdent(obj.canonical.database ?? defaultDatabase, name) +
    tokens
      .slice(node.name.to)
      .map((t) => t.text)
      .join("");
  const canonical = canonicalObject(ddl, defaultDatabase);
  return { ...obj, ddl, canonical, key: `${canonical.database}.${canonical.name}` };
}

// ── tables ────────────────────────────────────────────────────────────

/** A column's whole definition as declared: from its name to the comma or parenthesis that ends it. */
function columnDefinition(tokens: Token[], node: TableNode, name: string): string {
  const col = node.columns.find((c) => c.name === name);
  if (!col) throw new Error(`no declared column ${name}`);
  let depth = 0;
  let i = col.nameSpan.from;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") {
      if (depth === 0) break;
      depth--;
    } else if (t.text === "," && depth === 0) break;
  }
  return tokens
    .slice(col.nameSpan.from, i)
    .filter((t) => t.kind !== "comment")
    .map((t) => t.text)
    .join("")
    .trim();
}

function columnType(tokens: Token[], node: TableNode, name: string): string {
  const col = node.columns.find((c) => c.name === name)!;
  const type = text(tokens, col.type) ?? "";
  return `${type}${col.nullable === true ? " NULL" : col.nullable === false ? " NOT NULL" : ""}`;
}

/** Where a column goes: after the declared column before it, or first. */
function position(node: TableNode, name: string): string {
  const i = node.columns.findIndex((c) => c.name === name);
  return i <= 0 ? "FIRST" : `AFTER ${ident(node.columns[i - 1]!.name)}`;
}

/** `columns.<name>` or `columns.<name>.<part>`. */
function columnField(field: string): { column: string; part?: string } | undefined {
  const m = /^columns\.([^.]+)(?:\.(type|default|codec|ttl|comment))?$/.exec(field);
  return m ? { column: m[1]!, ...(m[2] ? { part: m[2] } : {}) } : undefined;
}

/**
 * The column order once the steps before it have run, and the moves that make
 * it the declared order.
 */
function reorderSteps(t: string, tokens: Token[], node: TableNode, live: CanonicalObject | undefined, changes: readonly Change[]): Step[] {
  if (!live) return [];
  const renamed = new Map(changes.filter((c) => c.rule === "SQLCH212").map((c) => [c.before!, c.after!]));
  const dropped = new Set(changes.filter((c) => c.rule === "SQLCH202").map((c) => columnField(c.field)!.column));
  const declared = node.columns.map((c) => c.name);
  const current = live.columns.map((c) => renamed.get(c.name) ?? c.name).filter((n) => !dropped.has(n));
  // Added columns went in at their declared place.
  for (const [i, name] of declared.entries()) {
    if (current.includes(name)) continue;
    const prev = i === 0 ? -1 : current.indexOf(declared[i - 1]!);
    current.splice(prev + 1, 0, name);
  }
  const steps: Step[] = [];
  for (const [i, name] of declared.entries()) {
    const want = i === 0 ? undefined : declared[i - 1];
    const at = current.indexOf(name);
    const have = at <= 0 ? undefined : current[at - 1];
    if (have === want) continue;
    current.splice(at, 1);
    current.splice(want === undefined ? 0 : current.indexOf(want) + 1, 0, name);
    steps.push({ sql: `ALTER TABLE ${t} MODIFY COLUMN ${ident(name)} ${columnType(tokens, node, name)} ${want === undefined ? "FIRST" : `AFTER ${ident(want)}`}`, rewrite: false });
  }
  return steps;
}

function tableSteps(obj: DeclaredObject, changes: readonly Change[], live: CanonicalObject | undefined): Step[] {
  const { tokens, node } = parsed(obj) as { tokens: Token[]; node: TableNode };
  const t = objectIdent(obj);
  const alter = (clause: string, rewrite = false): Step => ({ sql: `ALTER TABLE ${t} ${clause}`, rewrite });
  const steps: Step[] = [];
  const of = (rule: string) => changes.filter((c) => c.rule === rule);

  for (const c of of("SQLCH212")) steps.push(alter(`RENAME COLUMN ${ident(c.before!)} TO ${ident(c.after!)}`));

  // Added columns, in declared order, each at its declared place. Appending
  // new columns to the sorting key has to happen in the same ALTER as adding
  // them (SQLCH216), so then they go together.
  const added = of("SQLCH201")
    .map((c) => columnField(c.field)!.column)
    .sort((a, b) => node.columns.findIndex((c) => c.name === a) - node.columns.findIndex((c) => c.name === b));
  const adds = added.map((name) => `ADD COLUMN ${columnDefinition(tokens, node, name)} ${position(node, name)}`);
  const sortKey = of("SQLCH216")[0];
  if (sortKey) steps.push(alter([...adds, `MODIFY ORDER BY ${text(tokens, node.orderBy)}`].join(", ")));
  else for (const a of adds) steps.push(alter(a));

  for (const c of of("SQLCH202")) steps.push(alter(`DROP COLUMN ${ident(columnField(c.field)!.column)}`));

  for (const c of changes) {
    const f = columnField(c.field);
    if (!f?.part) continue;
    const col = node.columns.find((x) => x.name === f.column)!;
    const name = ident(f.column);
    switch (c.rule) {
      case "SQLCH210":
        steps.push(alter(`MODIFY COLUMN ${name} ${columnType(tokens, node, f.column)}`, true));
        break;
      case "SQLCH207":
        if (col.default) steps.push(alter(`MODIFY COLUMN ${name} ${col.default.kind}${col.default.expr ? ` ${text(tokens, col.default.expr)}` : ""}`));
        else steps.push(alter(`MODIFY COLUMN ${name} REMOVE ${(c.before ?? "DEFAULT").split(" ")[0]}`));
        break;
      case "SQLCH208":
        steps.push(alter(col.codec ? `MODIFY COLUMN ${name} CODEC(${text(tokens, col.codec)})` : `MODIFY COLUMN ${name} REMOVE CODEC`));
        break;
      case "SQLCH205":
        steps.push(alter(col.ttl ? `MODIFY COLUMN ${name} TTL ${text(tokens, col.ttl)}` : `MODIFY COLUMN ${name} REMOVE TTL`, true));
        break;
      case "SQLCH203":
        steps.push(alter(`COMMENT COLUMN ${name} ${sqlString(obj.canonical.columns.find((x) => x.name === f.column)?.comment ?? "")}`));
        break;
    }
  }

  for (const c of of("SQLCH204")) {
    const name = c.field.slice("indexes.".length);
    if (c.before !== undefined) steps.push(alter(`DROP INDEX ${ident(name)}`));
    const ix = node.indexes.find((x) => x.name === name);
    if (ix) {
      steps.push(
        alter(`ADD INDEX ${ident(name)} ${text(tokens, ix.expr)} TYPE ${text(tokens, ix.type)}${ix.granularity ? ` GRANULARITY ${text(tokens, ix.granularity)}` : ""}`),
      );
    }
  }
  for (const c of of("SQLCH214")) {
    const name = c.field.slice("projections.".length);
    if (c.before !== undefined) steps.push(alter(`DROP PROJECTION ${ident(name)}`));
    const p = node.projections.find((x) => x.name === name);
    if (p) steps.push(alter(`ADD PROJECTION ${ident(name)} (${text(tokens, p.body)})`));
  }
  for (const c of of("SQLCH215")) {
    const name = c.field.slice("constraints.".length);
    if (c.before !== undefined) steps.push(alter(`DROP CONSTRAINT ${ident(name)}`));
    const k = node.constraints.find((x) => x.name === name);
    if (k) steps.push(alter(`ADD CONSTRAINT ${ident(name)} ${k.kind} ${text(tokens, k.expr)}`));
  }

  for (const c of of("SQLCH205").filter((x) => x.field === "ttl")) {
    steps.push(alter(node.ttl ? `MODIFY TTL ${text(tokens, node.ttl)}` : "REMOVE TTL", true));
  }
  for (const c of of("SQLCH217")) {
    void c;
    steps.push(alter(node.sampleBy ? `MODIFY SAMPLE BY ${text(tokens, node.sampleBy)}` : "REMOVE SAMPLE BY"));
  }
  for (const c of of("SQLCH206")) {
    const key = c.field.slice("settings.".length);
    const s = node.settings?.find((x) => x.key === key);
    // A setting declared at its default compares as absent: set it as written.
    steps.push(alter(s ? `MODIFY SETTING ${key} = ${text(tokens, s.value)}` : `RESET SETTING ${key}`));
  }

  if (of("SQLCH209").length > 0) steps.push(...reorderSteps(t, tokens, node, live, changes));
  return steps;
}

function viewSteps(obj: DeclaredObject, changes: readonly Change[], marker: OwnershipMarker | undefined): Step[] {
  const { tokens, node } = parsed(obj) as { tokens: Token[]; node: ViewNode };
  const t = objectIdent(obj);
  const steps: Step[] = [];
  if (!node.materialized) {
    if (changes.some((c) => c.rule === "SQLCH240")) steps.push({ sql: createStatement(obj, marker, { orReplace: true }), rewrite: false });
    return steps;
  }
  if (changes.some((c) => c.rule === "SQLCH241")) steps.push({ sql: `ALTER TABLE ${t} MODIFY QUERY ${text(tokens, node.select)}`, rewrite: false });
  if (changes.some((c) => c.rule === "SQLCH244") && node.refresh) steps.push({ sql: `ALTER TABLE ${t} MODIFY REFRESH ${text(tokens, node.refresh)}`, rewrite: false });
  return steps;
}

/**
 * The statements that make an existing object match its declaration, for the
 * metadata and background-rewrite changes the classifier reported for it.
 * Rebuild-class changes are not handled here: the caller refuses them.
 * `live` is the object's current definition, which a column reorder needs.
 *
 * The object's own comment, and chant's marker in it, are not set here
 * (`commentStatement`), except where a plain view is replaced whole.
 */
export function alterSteps(obj: DeclaredObject, changes: readonly Change[], opts: { live?: CanonicalObject; marker?: OwnershipMarker } = {}): Step[] {
  const steps: Step[] = [];
  for (const c of changes.filter((x) => x.rule === "SQLCH231")) steps.push({ sql: `RENAME DATABASE ${ident(c.before!)} TO ${ident(c.after!)}`, rewrite: false });
  for (const c of changes.filter((x) => x.rule === "SQLCH230")) {
    const from = splitQualified(c.before!);
    const to = splitQualified(c.after!);
    steps.push({ sql: `RENAME TABLE ${qualifiedIdent(from.database, from.name)} TO ${qualifiedIdent(to.database, to.name)}`, rewrite: false });
  }
  if (obj.type === CLICKHOUSE_ENTITY_TYPES.table) steps.push(...tableSteps(obj, changes, opts.live));
  else if (obj.type === CLICKHOUSE_ENTITY_TYPES.view || obj.type === CLICKHOUSE_ENTITY_TYPES.materializedView) steps.push(...viewSteps(obj, changes, opts.marker));
  return steps;
}

/** Whether the steps for these changes already set the object's comment (a plain view replaced whole). */
export function stepsSetComment(obj: DeclaredObject, changes: readonly Change[]): boolean {
  return obj.type === CLICKHOUSE_ENTITY_TYPES.view && changes.some((c) => c.rule === "SQLCH240");
}
