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
import { CLASSIFIER_RULES, type ChangeClass, type ClassifierRuleId } from "../plan/rules";
import { stampedComment } from "../ownership";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "../entities";
import { renderFor, type Topology } from "../topology";

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

/** One statement to send, the change it makes, and whether it starts a background rewrite to wait on. */
export interface Step {
  sql: string;
  /** A mutation follows on the server; wait on `system.mutations` before the next step. */
  rewrite: boolean;
  /** The classifier rule of the change it makes. */
  rule: ClassifierRuleId;
  /** That rule's class. */
  class: ChangeClass;
}

/** The step for a statement that makes a change under `rule`: a rewrite-class rule waits on its mutation. */
export function stepFor(sql: string, rule: ClassifierRuleId): Step {
  const cls = CLASSIFIER_RULES[rule].class;
  return { sql, rewrite: cls === "rewrite", rule, class: cls };
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
    steps.push(stepFor(`ALTER TABLE ${t} MODIFY COLUMN ${ident(name)} ${columnType(tokens, node, name)} ${want === undefined ? "FIRST" : `AFTER ${ident(want)}`}`, "SQLCH209"));
  }
  return steps;
}

function tableSteps(obj: DeclaredObject, changes: readonly Change[], live: CanonicalObject | undefined): Step[] {
  const { tokens, node } = parsed(obj) as { tokens: Token[]; node: TableNode };
  const t = objectIdent(obj);
  const alter = (clause: string, rule: ClassifierRuleId): Step => stepFor(`ALTER TABLE ${t} ${clause}`, rule);
  const steps: Step[] = [];
  const of = (rule: string) => changes.filter((c) => c.rule === rule);

  for (const c of of("SQLCH212")) steps.push(alter(`RENAME COLUMN ${ident(c.before!)} TO ${ident(c.after!)}`, "SQLCH212"));

  // Added columns, in declared order, each at its declared place. Appending
  // new columns to the sorting key has to happen in the same ALTER as adding
  // them (SQLCH216), so then they go together.
  const added = of("SQLCH201")
    .map((c) => columnField(c.field)!.column)
    .sort((a, b) => node.columns.findIndex((c) => c.name === a) - node.columns.findIndex((c) => c.name === b));
  const adds = added.map((name) => `ADD COLUMN ${columnDefinition(tokens, node, name)} ${position(node, name)}`);
  const sortKey = of("SQLCH216")[0];
  if (sortKey) steps.push(alter([...adds, `MODIFY ORDER BY ${text(tokens, node.orderBy)}`].join(", "), "SQLCH216"));
  else for (const a of adds) steps.push(alter(a, "SQLCH201"));

  for (const c of of("SQLCH202")) steps.push(alter(`DROP COLUMN ${ident(columnField(c.field)!.column)}`, "SQLCH202"));

  for (const c of changes) {
    const f = columnField(c.field);
    if (!f?.part) continue;
    const col = node.columns.find((x) => x.name === f.column)!;
    const name = ident(f.column);
    switch (c.rule) {
      case "SQLCH210":
        steps.push(alter(`MODIFY COLUMN ${name} ${columnType(tokens, node, f.column)}`, c.rule));
        break;
      case "SQLCH207":
        if (col.default) steps.push(alter(`MODIFY COLUMN ${name} ${col.default.kind}${col.default.expr ? ` ${text(tokens, col.default.expr)}` : ""}`, c.rule));
        else steps.push(alter(`MODIFY COLUMN ${name} REMOVE ${(c.before ?? "DEFAULT").split(" ")[0]}`, c.rule));
        break;
      case "SQLCH208":
        steps.push(alter(col.codec ? `MODIFY COLUMN ${name} CODEC(${text(tokens, col.codec)})` : `MODIFY COLUMN ${name} REMOVE CODEC`, c.rule));
        break;
      case "SQLCH205":
        steps.push(alter(col.ttl ? `MODIFY COLUMN ${name} TTL ${text(tokens, col.ttl)}` : `MODIFY COLUMN ${name} REMOVE TTL`, c.rule));
        break;
      case "SQLCH203":
        steps.push(alter(`COMMENT COLUMN ${name} ${sqlString(obj.canonical.columns.find((x) => x.name === f.column)?.comment ?? "")}`, c.rule));
        break;
    }
  }

  for (const c of of("SQLCH204")) {
    const name = c.field.slice("indexes.".length);
    if (c.before !== undefined) steps.push(alter(`DROP INDEX ${ident(name)}`, c.rule));
    const ix = node.indexes.find((x) => x.name === name);
    if (ix) {
      steps.push(
        alter(`ADD INDEX ${ident(name)} ${text(tokens, ix.expr)} TYPE ${text(tokens, ix.type)}${ix.granularity ? ` GRANULARITY ${text(tokens, ix.granularity)}` : ""}`, c.rule),
      );
    }
  }
  for (const c of of("SQLCH214")) {
    const name = c.field.slice("projections.".length);
    if (c.before !== undefined) steps.push(alter(`DROP PROJECTION ${ident(name)}`, c.rule));
    const p = node.projections.find((x) => x.name === name);
    if (p) steps.push(alter(`ADD PROJECTION ${ident(name)} (${text(tokens, p.body)})`, c.rule));
  }
  for (const c of of("SQLCH215")) {
    const name = c.field.slice("constraints.".length);
    if (c.before !== undefined) steps.push(alter(`DROP CONSTRAINT ${ident(name)}`, c.rule));
    const k = node.constraints.find((x) => x.name === name);
    if (k) steps.push(alter(`ADD CONSTRAINT ${ident(name)} ${k.kind} ${text(tokens, k.expr)}`, c.rule));
  }

  for (const c of of("SQLCH205").filter((x) => x.field === "ttl")) {
    steps.push(alter(node.ttl ? `MODIFY TTL ${text(tokens, node.ttl)}` : "REMOVE TTL", c.rule));
  }
  for (const c of of("SQLCH217")) steps.push(alter(node.sampleBy ? `MODIFY SAMPLE BY ${text(tokens, node.sampleBy)}` : "REMOVE SAMPLE BY", c.rule));
  for (const c of of("SQLCH206")) {
    const key = c.field.slice("settings.".length);
    const s = node.settings?.find((x) => x.key === key);
    // A setting declared at its default compares as absent: set it as written.
    steps.push(alter(s ? `MODIFY SETTING ${key} = ${text(tokens, s.value)}` : `RESET SETTING ${key}`, c.rule));
  }

  if (of("SQLCH209").length > 0) steps.push(...reorderSteps(t, tokens, node, live, changes));
  return steps;
}

function viewSteps(obj: DeclaredObject, changes: readonly Change[], marker: OwnershipMarker | undefined): Step[] {
  const { tokens, node } = parsed(obj) as { tokens: Token[]; node: ViewNode };
  const t = objectIdent(obj);
  const steps: Step[] = [];
  if (!node.materialized) {
    if (changes.some((c) => c.rule === "SQLCH240")) steps.push(stepFor(createStatement(obj, marker, { orReplace: true }), "SQLCH240"));
    return steps;
  }
  if (changes.some((c) => c.rule === "SQLCH241")) steps.push(stepFor(`ALTER TABLE ${t} MODIFY QUERY ${text(tokens, node.select)}`, "SQLCH241"));
  if (changes.some((c) => c.rule === "SQLCH244") && node.refresh) steps.push(stepFor(`ALTER TABLE ${t} MODIFY REFRESH ${text(tokens, node.refresh)}`, "SQLCH244"));
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
  for (const c of changes.filter((x) => x.rule === "SQLCH231")) steps.push(stepFor(`RENAME DATABASE ${ident(c.before!)} TO ${ident(c.after!)}`, "SQLCH231"));
  for (const c of changes.filter((x) => x.rule === "SQLCH230")) {
    const from = splitQualified(c.before!);
    const to = splitQualified(c.after!);
    steps.push(stepFor(`RENAME TABLE ${qualifiedIdent(from.database, from.name)} TO ${qualifiedIdent(to.database, to.name)}`, "SQLCH230"));
  }
  if (obj.type === CLICKHOUSE_ENTITY_TYPES.table) steps.push(...tableSteps(obj, changes, opts.live));
  else if (obj.type === CLICKHOUSE_ENTITY_TYPES.view || obj.type === CLICKHOUSE_ENTITY_TYPES.materializedView) steps.push(...viewSteps(obj, changes, opts.marker));
  return steps;
}

/** Whether the steps for these changes already set the object's comment (a plain view replaced whole). */
export function stepsSetComment(obj: DeclaredObject, changes: readonly Change[]): boolean {
  return obj.type === CLICKHOUSE_ENTITY_TYPES.view && changes.some((c) => c.rule === "SQLCH240");
}

// ── a schema's statements ─────────────────────────────────────────────

/**
 * What one declared object takes, as the applier and the offline renderer
 * (`../../migration-statements.ts`) both see it:
 *
 * - `create` or `alter`: the statements, in the order they run. An `alter`
 *   with none is an object already as declared.
 * - `rebuild`: a change ALTER cannot make; nothing is sent for the object and
 *   the rebuild migration Op makes it (`detail` names the Op).
 * - `withheld`: a column drop, which destroys data, in a plan not allowed to
 *   delete.
 */
export type ObjectStatements =
  | { verdict: "create" | "alter"; obj: DeclaredObject; changes: Change[]; steps: Step[] }
  | { verdict: "rebuild"; obj: DeclaredObject; changes: Change[]; refused: Change[]; detail: string }
  | { verdict: "withheld"; obj: DeclaredObject; changes: Change[]; withheld: Change[]; detail: string };

/** An object a schema no longer declares, and the `DROP` for it. */
export interface DropStatement {
  /** The key the changes name it by. */
  key: string;
  type: ClickHouseEntityType;
  database?: string;
  name: string;
  step: Step;
}

export interface StatementPlanInput {
  /** The declared objects, in creation order. */
  declared: readonly DeclaredObject[];
  /** The classified changes from the current schema to the declared one. */
  changes: readonly Change[];
  /** The current definitions, keyed as the changes key objects. */
  current: ReadonlyMap<string, CanonicalObject>;
  /** How the changes key a declared object: `database.name` against a server (the default), the export name between two builds. */
  keyOf?: (obj: DeclaredObject) => string;
  /** The marker every `CREATE` and restamped comment carries. */
  marker?: OwnershipMarker;
  /** Column drops are planned, not withheld. Default: off. */
  allowDestructive?: boolean;
  /** Whether the current object (by its key in `current`) carries the marker already; one that does not is restamped. Default: it does. */
  carriesMarker?: (currentKey: string) => boolean;
  /**
   * The topology every statement is rendered for (`../topology.ts`): `ON
   * CLUSTER` and the engine. The declarations should be rendered for it too
   * (`declaredObjects(json, db, topology)`), so the changes compare the
   * engine the topology runs. Default: the statements as declared.
   */
  topology?: Topology;
}

export interface StatementPlan {
  /** One entry per declared object, in creation order. */
  objects: ObjectStatements[];
  /** The objects the declarations no longer hold, in drop order: what reads from a table first, a database last. */
  drops: DropStatement[];
}

/** Drop order: what reads from a table before the table, a database last. */
const DROP_ORDER: Record<string, number> = { materializedView: 0, view: 1, table: 2, database: 3 };

/**
 * The statements that take the current schema to the declared one, from the
 * classified changes between them. Pure: nothing is read or sent. The applier
 * (`./apply.ts`) runs the steps against a server; `diffStatements`
 * (`../../migration-statements.ts`) renders the same steps for a migration
 * file. Anything that changes the SQL sent for a change belongs here, so
 * both see it.
 */
export function planStatements(input: StatementPlanInput): StatementPlan {
  const plan = planDeclared(input);
  if (!input.topology) return plan;
  const topology = input.topology;
  const render = (step: Step): Step => ({ ...step, sql: renderFor(step.sql, topology) });
  return {
    objects: plan.objects.map((o) => (o.verdict === "create" || o.verdict === "alter" ? { ...o, steps: o.steps.map(render) } : o)),
    drops: plan.drops.map((d) => ({ ...d, step: render(d.step) })),
  };
}

function planDeclared(input: StatementPlanInput): StatementPlan {
  const keyOf = input.keyOf ?? ((o: DeclaredObject) => o.key);
  const byObject = new Map<string, Change[]>();
  for (const c of input.changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);

  const objects: ObjectStatements[] = input.declared.map((obj): ObjectStatements => {
    const key = keyOf(obj);
    const mine = byObject.get(key) ?? [];
    const refused = mine.filter(isRebuild);
    if (refused.length > 0) return { verdict: "rebuild", obj, changes: mine, refused, detail: refusalDetail(refused, obj.key, obj.type) };
    const destructive = mine.filter(isDestructiveAlter);
    if (destructive.length > 0 && !input.allowDestructive) {
      return {
        verdict: "withheld",
        obj,
        changes: mine,
        withheld: destructive,
        detail: `drops ${destructive.map((c) => c.field).join(", ")}, which destroys the data in it; an apply that may delete (prune, ApplyOp delete "owned-only" or "gated") makes it`,
      };
    }
    if (mine.some((c) => c.rule === "SQLCH200")) return { verdict: "create", obj, changes: mine, steps: [stepFor(createStatement(obj, input.marker), "SQLCH200")] };

    const renamedFrom = mine.find((c) => c.rule === "SQLCH230" || c.rule === "SQLCH231")?.before;
    const currentKey = renamedFrom !== undefined && input.current.has(renamedFrom) ? renamedFrom : key;
    const live = input.current.get(currentKey);
    const restamp = !stepsSetComment(obj, mine) && (mine.some((c) => c.field === "comment") || !(input.carriesMarker?.(currentKey) ?? true));
    const steps = [
      ...alterSteps(obj, mine, { ...(live ? { live } : {}), ...(input.marker ? { marker: input.marker } : {}) }),
      ...(restamp ? [stepFor(commentStatement(obj, input.marker), "SQLCH203")] : []),
    ];
    return { verdict: "alter", obj, changes: mine, steps };
  });

  const drops: DropStatement[] = [];
  for (const c of input.changes) {
    if (c.rule !== "SQLCH250") continue;
    const o = input.current.get(c.object);
    if (!o) continue;
    const type = CLICKHOUSE_ENTITY_TYPES[o.kind as keyof typeof CLICKHOUSE_ENTITY_TYPES];
    const database = o.kind === "database" ? undefined : o.database;
    drops.push({ key: c.object, type, ...(database !== undefined ? { database } : {}), name: o.name, step: stepFor(dropStatement(type, database, o.name), "SQLCH250") });
  }
  drops.sort((a, b) => (DROP_ORDER[kindOf(a.type)] ?? 9) - (DROP_ORDER[kindOf(b.type)] ?? 9));
  return { objects, drops };
}

const kindOf = (type: string): string => Object.entries(CLICKHOUSE_ENTITY_TYPES).find(([, t]) => t === type)?.[0] ?? "table";
