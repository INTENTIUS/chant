/**
 * The ClickHouse statement classifier (#4407): a migration file's statements,
 * each given the class and rule the schema-diff classifier (`./rules.ts`)
 * gives the same change. It reads text and contacts no server.
 *
 * `CREATE` goes through the declaration parser (`../parser.ts`), which also
 * tells the classifier a table's keys when the file creates the table. The
 * parser has no `ALTER` grammar, so `ALTER`, `DROP` and `RENAME` are read word
 * by word from the same tokens.
 *
 * A statement alone cannot decide some changes, and those answer `undecided`
 * naming both rules, the way `./disruption.ts` answers `unknown`:
 *
 * - `MODIFY COLUMN c <type>` is SQLCH210 (a rewrite), or SQLCH211 (a rebuild)
 *   when `c` is in a key. The file states the keys only when it creates the
 *   table.
 * - `DROP COLUMN` is SQLCH202 or SQLCH213, and `RENAME COLUMN` SQLCH212 or
 *   SQLCH213, on the same condition.
 * - `MODIFY ORDER BY` that the same `ALTER` pairs with `ADD COLUMN` is SQLCH216
 *   when it only appends those columns and SQLCH220 (a rebuild) otherwise.
 *   Without such a column it is SQLCH220.
 */

import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";
import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseCreate, type CreateNode } from "../parser";
import type { Span } from "../../core/cursor";
import { classifiedOf, splitTopLevel, sqlHead, type StatementClassified, type StatementVerdict } from "../../core/statement-class";
import { CHANGE_CLASSES, CLASSIFIER_RULES, type ClassifierRuleId } from "./rules";

const classified = (id: ClassifierRuleId, extra: Partial<StatementClassified> = {}): StatementClassified => classifiedOf(CLASSIFIER_RULES, CHANGE_CLASSES.label, id, extra);

type Reading = { rules: Array<{ id: ClassifierRuleId; extra?: Partial<StatementClassified> }> } | { undecided: ClassifierRuleId[]; note: string } | { none: string } | { data: string };

const rule = (id: ClassifierRuleId, extra?: Partial<StatementClassified>): Reading => ({ rules: [{ id, ...(extra ? { extra } : {}) }] });

/** Settings only a stream engine takes (the same list `./disruption.ts` reads). */
const STREAM_SETTING = /^(?:kafka_|rabbitmq_|nats_|s3queue_|azure_queue_|keeper_path$)/;

/** What a table the file creates tells later statements in it. */
interface Created {
  /** The columns in the sorting, primary, partition or sampling key. */
  keys: Set<string>;
  orderBy?: string;
}

const bare = (name: string): string => (name.split(".").pop() ?? name).replace(/^[`"]|[`"]$/g, "").toLowerCase();

const text = (tokens: readonly Token[], s: Span | undefined): string => (s ? tokens.slice(s.from, s.to).filter((t) => !isTrivia(t)).map((t) => t.text).join(" ") : "");

/** The identifier tokens of a key expression that are not function names. */
function columnsOf(tokens: readonly Token[], s: Span | undefined): string[] {
  if (!s) return [];
  const toks = tokens.slice(s.from, s.to).filter((t) => !isTrivia(t));
  return toks.flatMap((t, i) => ((t.kind === "ident" || t.kind === "qident") && toks[i + 1]?.text !== "(" ? [bare(t.text)] : []));
}

function nameAt(words: readonly string[], i: number): { name: string; next: number } {
  let name = words[i] ?? "";
  let j = i + 1;
  while (words[j] === "." && words[j + 1] !== undefined) {
    name += `.${words[j + 1]}`;
    j += 2;
  }
  return { name, next: j };
}

const KNOWN_VERBS = new Set(["ADD", "DROP", "RENAME", "MODIFY", "COMMENT", "CLEAR", "MATERIALIZE", "UPDATE", "DELETE", "ATTACH", "DETACH", "FREEZE", "FETCH", "MOVE", "REPLACE", "RESET", "REMOVE", "APPLY", "UNFREEZE", "EXECUTE"]);

/** Normalise a key expression for comparing an old and a new one: no spaces, no outer parentheses. */
const keyText = (words: readonly string[]): string => {
  let t = words.join("").toLowerCase();
  while (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1);
  return t;
};

interface TableContext {
  created?: Created;
  /** Columns the same ALTER adds. */
  added: Set<string>;
}

function columnVerdict(kind: "drop" | "rename", col: string, ctx: TableContext): Reading {
  const plain: ClassifierRuleId = kind === "drop" ? "SQLCH202" : "SQLCH212";
  const extra = kind === "drop" ? { destructive: true } : undefined;
  if (ctx.created) {
    return ctx.created.keys.has(bare(col)) ? rule("SQLCH213", extra) : rule(plain, extra);
  }
  return { undecided: [plain, "SQLCH213"], note: `${col} is a column change or, in a key, a rebuild; the file does not create the table, so its keys are not known offline` };
}

function tableAction(a: readonly string[], ctx: TableContext): Reading {
  const u = a.map((w) => w.toUpperCase());
  const first = u[0];
  const second = u[1];
  if (first === "ADD") {
    if (second === "COLUMN") return rule("SQLCH201");
    if (second === "INDEX") return rule("SQLCH204");
    if (second === "PROJECTION") return rule("SQLCH214");
    if (second === "CONSTRAINT") return rule("SQLCH215");
    return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")}` };
  }
  if (first === "DROP") {
    if (second === "COLUMN") {
      const k = u[2] === "IF" ? 4 : 2;
      return columnVerdict("drop", a[k] ?? "column", ctx);
    }
    if (second === "INDEX") return rule("SQLCH204");
    if (second === "PROJECTION") return rule("SQLCH214");
    if (second === "CONSTRAINT") return rule("SQLCH215");
    return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")} (removes data parts, no rule covers it)` };
  }
  if (first === "CLEAR") {
    if (second === "INDEX") return rule("SQLCH204");
    if (second === "PROJECTION") return rule("SQLCH214");
    return { none: `ALTER TABLE CLEAR ${second ?? ""}`.trim() };
  }
  if (first === "RENAME" && second === "COLUMN") {
    const k = u[2] === "IF" ? 4 : 2;
    return columnVerdict("rename", a[k] ?? "column", ctx);
  }
  if (first === "COMMENT" && second === "COLUMN") return rule("SQLCH203");
  if (first === "MODIFY" || first === "RESET") {
    if (second === "COLUMN") {
      let k = 2;
      if (u[k] === "IF" && u[k + 1] === "EXISTS") k += 2;
      const col = a[k] ?? "column";
      const after = u[k + 1];
      if (after === "REMOVE") {
        const what = u[k + 2];
        return what === "CODEC" ? rule("SQLCH208") : what === "COMMENT" ? rule("SQLCH203") : what === "TTL" ? rule("SQLCH205") : rule("SQLCH207");
      }
      if (after === "DEFAULT" || after === "MATERIALIZED" || after === "ALIAS" || after === "EPHEMERAL") return rule("SQLCH207");
      if (after === "CODEC") return rule("SQLCH208");
      if (after === "COMMENT") return rule("SQLCH203");
      if (after === "TTL") return rule("SQLCH205");
      if (after === "MODIFY" || after === "RESET") return { none: "MODIFY COLUMN ... SETTING" };
      if (after === undefined) return { none: "MODIFY COLUMN with no change" };
      if (ctx.created) return ctx.created.keys.has(bare(col)) ? rule("SQLCH211") : rule("SQLCH210");
      return { undecided: ["SQLCH210", "SQLCH211"], note: `a type change of ${col} is a background rewrite or, when ${col} is in a key, a rebuild; the file does not create the table, so its keys are not known offline` };
    }
    if (second === "ORDER" && u[2] === "BY") {
      const next = a.slice(3);
      if (ctx.created?.orderBy !== undefined) {
        const was = ctx.created.orderBy;
        const now = keyText(next);
        const tail = now.startsWith(was) ? now.slice(was.length) : undefined;
        const extra = tail === undefined ? [] : tail.split(/[^a-z0-9_]+/).filter(Boolean);
        if (tail !== undefined && extra.length > 0 && extra.every((c) => ctx.added.has(c))) return rule("SQLCH216");
        return rule("SQLCH220");
      }
      const mentions = next.some((w) => ctx.added.has(bare(w)));
      if (mentions) return { undecided: ["SQLCH216", "SQLCH220"], note: "the new key appends the columns this ALTER adds only if its other elements are the old key's, which the file does not state" };
      return rule("SQLCH220");
    }
    if (second === "SAMPLE" && u[2] === "BY") return rule("SQLCH217");
    if (second === "TTL") return rule("SQLCH205");
    if (second === "COMMENT") return rule("SQLCH203");
    if (second === "QUERY") return rule("SQLCH241");
    if (second === "REFRESH") return rule("SQLCH244");
    if (second === "SETTING" || second === "SETTINGS") {
      const key = (a[2] ?? "").toLowerCase();
      return settingRule(key);
    }
    return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")}` };
  }
  if (first === "REMOVE") {
    if (second === "TTL") return rule("SQLCH205");
    if (second === "SAMPLE" && u[2] === "BY") return rule("SQLCH217");
    return { none: `ALTER TABLE REMOVE ${second ?? ""}`.trim() };
  }
  if (first === "UPDATE" || first === "DELETE") return { data: "a mutation: it rewrites the parts it touches in the background (system.mutations) and has no rollback" };
  return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")}` };
}

function settingRule(key: string): Reading {
  if (STREAM_SETTING.test(key)) return rule("SQLCH225", { note: `${key} belongs to a stream engine, which has no MODIFY SETTING` });
  const spec = (MERGE_TREE_SETTINGS as Record<string, { readonly: boolean } | undefined>)[key];
  return spec?.readonly ? rule("SQLCH218", { note: `${key} is fixed at creation` }) : rule("SQLCH206");
}

/** The `ALTER TABLE` actions of one statement, in order, a `MODIFY SETTING` list kept together. */
function alterTable(words: readonly string[], u: readonly string[], created: Map<string, Created>): Reading[] {
  let i = 2;
  if (u[i] === "IF" && u[i + 1] === "EXISTS") i += 2;
  const { name, next } = nameAt(words, i);
  i = next;
  if (u[i] === "ON" && u[i + 1] === "CLUSTER") i += 3;
  const actions = splitTopLevel(words.slice(i));
  const added = new Set<string>();
  for (const a of actions) {
    const au = a.map((w) => w.toUpperCase());
    if (au[0] === "ADD" && au[1] === "COLUMN") {
      const k = au[2] === "IF" ? 5 : 2;
      if (a[k]) added.add(bare(a[k]!));
    }
  }
  const ctx: TableContext = { added, ...(created.has(bare(name)) ? { created: created.get(bare(name))! } : {}) };
  const out: Reading[] = [];
  let inSettings = false;
  for (const a of actions) {
    const au = a.map((w) => w.toUpperCase());
    if (inSettings && au[0] !== undefined && !KNOWN_VERBS.has(au[0])) {
      out.push(settingRule((a[0] ?? "").toLowerCase()));
      continue;
    }
    inSettings = (au[0] === "MODIFY" || au[0] === "RESET") && (au[1] === "SETTING" || au[1] === "SETTINGS");
    out.push(tableAction(a, ctx));
  }
  return out;
}

const OBJECTS: Record<string, ClassifierRuleId> = { USER: "SQLCH271", ROLE: "SQLCH270", QUOTA: "SQLCH275" };

function alterOther(u: readonly string[]): Reading {
  const obj = u[1];
  if (obj && OBJECTS[obj]) return rule(OBJECTS[obj]!);
  if (obj === "ROW" && u[2] === "POLICY") return rule("SQLCH272");
  if (obj === "POLICY") return rule("SQLCH272");
  if (obj === "SETTINGS" && u[2] === "PROFILE") return rule("SQLCH276");
  if (obj === "DATABASE" && u.includes("COMMENT")) return rule("SQLCH203");
  return { none: `ALTER ${obj ?? ""}`.trim() };
}

const DATA_WORDS = new Set(["INSERT", "SELECT", "WITH", "SYSTEM", "OPTIMIZE", "TRUNCATE", "SET", "USE", "EXPLAIN", "EXISTS", "DESCRIBE", "DESC", "SHOW", "CHECK", "KILL", "WATCH"]);


/** A `CREATE` or `ATTACH`: the parser reads tables, views, dictionaries, databases and functions; the rest go by key words. */
function create(tokens: Token[], u: readonly string[], created: Map<string, Created>): Reading {
  let i = 1;
  const orReplace = u[i] === "OR" && u[i + 1] === "REPLACE";
  if (orReplace) i += 2;
  let node: CreateNode | undefined;
  try {
    node = parseCreate(tokens);
  } catch {
    node = undefined;
  }
  if (node?.statement === "table") {
    const name = text(tokens, node.name).replace(/\s*\.\s*/g, ".");
    const keys = new Set<string>([...columnsOf(tokens, node.orderBy), ...columnsOf(tokens, node.primaryKey), ...columnsOf(tokens, node.partitionBy), ...columnsOf(tokens, node.sampleBy)]);
    for (const c of node.columns) if (c.primaryKey) keys.add(bare(c.name));
    created.set(bare(name), { keys, ...(node.orderBy ? { orderBy: keyText(text(tokens, node.orderBy).split(" ")) } : {}) });
  }
  if (orReplace && u[i] === "FUNCTION") return rule("SQLCH260");
  if (orReplace && (u[i] === "TABLE" || node?.statement === "table")) return rule("SQLCH200", { note: "OR REPLACE drops an existing table of that name, and its rows, before it creates this one" });
  return rule("SQLCH200");
}

function read(sql: string, created: Map<string, Created>): Reading[] {
  let tokens: Token[];
  try {
    tokens = tokenizeText(sql, 0);
  } catch {
    return [{ none: "text the tokenizer could not read" }];
  }
  const words = tokens.filter((t) => !isTrivia(t) && t.text !== ";").map((t) => t.text);
  const u = words.map((w) => w.toUpperCase());
  const head = u[0];
  if (head === undefined) return [{ data: "an empty statement" }];
  if (head === "CREATE") return [create(tokens, u, created)];
  if (head === "ALTER" && u[1] === "TABLE") return alterTable(words, u, created);
  if (head === "ALTER") return [alterOther(u)];
  if (head === "DROP") return [rule("SQLCH250", { destructive: true })];
  if (head === "RENAME") {
    if (u[1] === "DATABASE") return [rule("SQLCH231")];
    if (u[1] === "TABLE" || u[1] === "DICTIONARY") return [rule("SQLCH230")];
    return [{ none: `RENAME ${u[1] ?? ""}`.trim() }];
  }
  if (head === "GRANT") return [rule("SQLCH273")];
  if (head === "REVOKE") return [rule("SQLCH274")];
  if (head === "EXCHANGE") return [{ none: "EXCHANGE TABLES swaps two tables; no rule covers it" }];
  if (head === "TRUNCATE") return [{ data: "TRUNCATE removes every row of the table" }];
  if (DATA_WORDS.has(head)) return [{ data: `${head} reads or writes rows or the session, not the schema` }];
  return [{ none: `${head} is not a statement the classifier reads` }];
}

/**
 * Classify a migration's up statements, in order. The statements are the
 * file's own text, one per entry.
 */
export function classifyClickHouseStatements(statements: readonly string[]): StatementVerdict[] {
  const created = new Map<string, Created>();
  return statements.map((sql, k) => {
    const readings = read(sql, created);
    const out: StatementVerdict = { index: k + 1, sql: sqlHead(sql), outcome: "classified", changes: [] };
    const none: string[] = [];
    const notes: string[] = [];
    for (const r of readings) {
      if ("rules" in r) out.changes.push(...r.rules.map((x) => classified(x.id, x.extra)));
      else if ("undecided" in r) {
        out.candidates = [...(out.candidates ?? []), ...r.undecided.map((id) => classified(id))];
        notes.push(r.note);
      } else if ("none" in r) none.push(r.none);
      else notes.push(r.data);
    }
    if (out.candidates) out.outcome = "undecided";
    else if (out.changes.length === 0 && none.length === 0) out.outcome = "data";
    else if (none.length > 0) {
      out.outcome = out.changes.length > 0 ? "classified" : "unclassified";
      notes.push(`no rule covers ${none.join("; ")}`);
    }
    if (notes.length > 0) out.note = notes.join("; ");
    return out;
  });
}
