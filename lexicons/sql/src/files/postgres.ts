/**
 * A file of Postgres DDL as the objects it declares: each `CREATE` (and each
 * `GRANT`, `REVOKE` and `ALTER DEFAULT PRIVILEGES`) is one object, and the
 * statements that only finish one are folded into it:
 *
 * - `COMMENT ON` joins the object it comments on, wherever in the file it is;
 * - `ALTER TABLE ... ENABLE | DISABLE | FORCE ROW LEVEL SECURITY` joins its table;
 * - `ALTER TABLE <t> ADD [CONSTRAINT <c>] FOREIGN KEY | UNIQUE | PRIMARY KEY |
 *   CHECK | EXCLUDE ...`, the form `pg_dump` and ORMs print constraints in,
 *   becomes a table constraint in `<t>`'s `CREATE TABLE`.
 *
 * `BEGIN` and `COMMIT` are skipped. Any other statement, and any statement
 * the parser or its tag refuses, is a problem naming it: a statement left
 * out would be a schema change nobody declared.
 *
 * With `schema`, the names the DDL leaves unqualified are qualified with it,
 * as an ORM's connection would: an object's own name, an index's, trigger's
 * or policy's table, a foreign key's table, a comment's target, and a column
 * type naming an enum or domain the file creates.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isTrivia, tokenizeText, type Token } from "../postgres/tokens";
import { identValue, parseStatements, type NameNode, type StatementNode } from "../postgres/parser";
import * as tags from "../postgres/entities";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "../postgres/entity-types";
import { POSTGRES_TAG_OF } from "../postgres/import/generator";
import type { ImportedPgObject } from "../postgres/import/ir";
import { firstLine, quoteBare, splitTokens, tokensText, type ReadOptions } from "./common";

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Declarable;

/** The tag that declares an entity type. */
export function postgresTag(type: string): Tag | undefined {
  const name = POSTGRES_TAG_OF[type];
  return name ? ((tags as unknown as Record<string, Tag>)[name] ?? undefined) : undefined;
}

/** A tagged-template call's strings from template-literal text: `raw` as written, as the tag reads it. */
export function templateStrings(parts: readonly string[]): TemplateStringsArray {
  return Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
}

const isName = (t: Token | undefined): boolean => t !== undefined && (t.kind === "ident" || t.kind === "qident");
const word = (t: Token | undefined, ...words: string[]): boolean => t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());

/** Text that sits inside a template literal: a backquote and `${` escaped. */
const templateSafe = (s: string) => s.replace(/\\(?=`|\$\{)/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

interface PgFileObject {
  node: StatementNode;
  /** The CREATE's tokens, then each statement folded into it. */
  statements: Token[][];
  /** Table constraints folded in from ALTER TABLE ... ADD, as SQL text. */
  constraints: string[];
}

/** Transaction control, which declares nothing. */
function isTransactionControl(sig: readonly Token[]): boolean {
  const words = sig.map((t) => (t.kind === "ident" ? t.text.toUpperCase() : ""));
  const [first, ...rest] = words;
  if (first === "BEGIN" || first === "COMMIT" || first === "END") return rest.every((w) => w === "TRANSACTION" || w === "WORK");
  return first === "START" && rest.length === 1 && rest[0] === "TRANSACTION";
}

/**
 * The objects a file of Postgres DDL declares, each with its statements
 * joined as one declaration's DDL. Problems are collected, not thrown, so a
 * file is reported whole.
 */
export function readPostgres(ddl: string, options: ReadOptions, problems: string[]): ImportedPgObject[] {
  const parsed: Array<{ tokens: Token[]; node: StatementNode }> = [];
  const alters: Array<{ table: string[]; constraint: string; sql: string }> = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0), isTrivia)) {
    const sig = stmt.filter((t) => !isTrivia(t));
    const sql = tokensText(stmt);
    if (isTransactionControl(sig)) continue;
    if (word(sig[0], "ALTER") && word(sig[1], "TABLE")) {
      const alter = readAlterAdd(stmt, sig);
      if (alter) {
        alters.push({ ...alter, sql });
        continue;
      }
    }
    if (!word(sig[0], "CREATE", "COMMENT", "GRANT", "REVOKE", "ALTER")) {
      problems.push(`not a statement that declares an object: ${firstLine(sql)}`);
      continue;
    }
    try {
      const tokens = tokenizeText(sql, 0);
      for (const node of parseStatements(tokens)) parsed.push({ tokens, node });
    } catch (e) {
      const what = word(sig[0], "ALTER") && word(sig[1], "TABLE") ? "an ALTER TABLE other than ADD of a table constraint or ROW LEVEL SECURITY" : `does not parse (${e instanceof Error ? e.message : String(e)})`;
      problems.push(`${what}: ${firstLine(sql)}`);
    }
  }

  const nameOf = (tokens: Token[], n: NameNode): string[] =>
    n.pieces.length > 0 && n.pieces.every((p) => p !== "") ? n.pieces : tokens.slice(n.span.from, n.span.to).filter((t) => isName(t)).map((t) => identValue(t));
  const qualify = (pieces: readonly string[]): { schema?: string; name: string } => {
    const name = pieces[pieces.length - 1] ?? "";
    const schema = pieces.length >= 2 ? pieces[pieces.length - 2] : options.schema;
    return schema ? { schema, name } : { name };
  };
  const key = (q: { schema?: string; name: string }) => `${q.schema ?? ""}.${q.name}`;

  // The types the file creates, so a column of one is qualified with the rest.
  const fileTypes = new Set<string>();
  for (const { tokens, node } of parsed) {
    if (node.statement === "enum" || node.statement === "domain") {
      const pieces = nameOf(tokens, node.name);
      if (pieces.length === 1) fileTypes.add(pieces[0]!);
    }
  }

  const objects: PgFileObject[] = [];
  /** Objects by namespace and name: `rel` (anything in a schema), `index`, `schema`, `extension`, `role`, and `trigger`/`policy` with their table. */
  const owners = new Map<string, PgFileObject>();
  const followOns: Array<{ tokens: Token[]; node: StatementNode; inserts: Set<number> }> = [];
  for (const { tokens, node } of parsed) {
    const inserts = new Set<number>();
    /** Qualifies an unqualified name in the statement, when `schema` is set. */
    const mark = (n: NameNode | undefined) => {
      if (!n || !options.schema) return;
      const names = tokens.slice(n.span.from, n.span.to).filter((t) => !isTrivia(t));
      const [only] = names;
      if (only && names.length === 1 && isName(only)) inserts.add(tokens.indexOf(only));
    };
    switch (node.statement) {
      case "comment":
        if (node.objectType !== "SCHEMA" && node.objectType !== "EXTENSION" && node.objectType !== "ROLE" && node.objectType !== "TRIGGER" && node.objectType !== "POLICY" && node.objectType !== "CONSTRAINT" && node.objectType !== "COLUMN") mark(node.target);
        if (node.objectType === "COLUMN" && nameOf(tokens, node.target).length === 2 && options.schema) {
          const first = tokens.slice(node.target.span.from, node.target.span.to).find((t) => !isTrivia(t));
          if (first) inserts.add(tokens.indexOf(first));
        }
        mark(node.on);
        followOns.push({ tokens, node, inserts });
        continue;
      case "rowSecurity":
        mark(node.table);
        followOns.push({ tokens, node, inserts });
        continue;
      case "index":
      case "trigger":
      case "policy":
        mark(node.table);
        break;
      case "table":
        for (const c of [...node.columns.flatMap((col) => col.constraints), ...node.constraints]) mark(c.references?.table);
        if (options.schema) {
          for (const col of node.columns) {
            if (!col.type) continue;
            const type = tokens.slice(col.type.from, col.type.to).filter((t) => !isTrivia(t));
            const first = type[0];
            if (first && isName(first) && fileTypes.has(identValue(first)) && !(type[1]?.kind === "punct" && type[1].text === ".")) inserts.add(tokens.indexOf(first));
          }
        }
        break;
      default:
        break;
    }
    if (node.statement === "schema" && !node.name) {
      problems.push(`a CREATE SCHEMA with no name: ${firstLine(tokensText(tokens))}`);
      continue;
    }
    if (node.statement === "index" && !node.name) {
      problems.push(`an index with no name (its declaration needs one): ${firstLine(tokensText(tokens))}`);
      continue;
    }
    const ownName = !["schema", "extension", "index", "trigger", "policy", "role", "grant"].includes(node.statement);
    if (ownName && "name" in node) mark(node.name);
    const object: PgFileObject = { node, statements: [rewrite(tokens, inserts, options.schema)], constraints: [] };
    objects.push(object);
    const k = ownerKey(node, tokens, nameOf, qualify);
    if (k) owners.set(k, object);
  }

  for (const f of followOns) {
    const k = followOnOwner(f.node, f.tokens, nameOf, qualify);
    const owner = k ? owners.get(k) : undefined;
    if (!owner) {
      const what = f.node.statement === "comment" ? `COMMENT ON ${f.node.objectType}` : "ALTER TABLE ... ROW LEVEL SECURITY";
      problems.push(`${what} for an object the file does not create: ${firstLine(tokensText(f.tokens))}`);
      continue;
    }
    owner.statements.push(rewrite(f.tokens, f.inserts, options.schema));
  }

  for (const alter of alters) {
    const table = owners.get(`rel ${key(qualify(alter.table))}`);
    if (!table || table.node.statement !== "table") {
      problems.push(`ALTER TABLE of a table the file does not create: ${firstLine(alter.sql)}`);
      continue;
    }
    table.constraints.push(qualifyConstraint(alter.constraint, options.schema));
  }

  const out: ImportedPgObject[] = [];
  for (const o of objects) {
    const [create = [], ...rest] = o.statements;
    const ddlText = [o.constraints.length > 0 ? addConstraints(create, o.constraints) : tokensText(create), ...rest.map((c) => tokensText(c))].join(";\n");
    const identity = identify(ddlText);
    if (typeof identity === "string") {
      problems.push(`${identity}: ${firstLine(ddlText)}`);
      continue;
    }
    out.push({ ...identity, ddl: ddlText });
  }
  return out;
}

/** An object's entity type, schema and name, read by declaring it with its tag; a string is the tag's refusal. */
function identify(ddl: string): { type: PostgresEntityType; schema?: string; name: string } | string {
  let tokens: Token[];
  let node: StatementNode | undefined;
  try {
    tokens = tokenizeText(ddl, 0);
    [node] = parseStatements(tokens);
  } catch (e) {
    return `does not parse (${e instanceof Error ? e.message : String(e)})`;
  }
  const type = node ? entityTypeOf(node) : undefined;
  const tag = type ? postgresTag(type) : undefined;
  if (!type || !tag) return "not a statement that declares an object";
  try {
    const entity = tag(templateStrings([templateSafe(ddl)]));
    const p = (entity as unknown as { props: { schema?: string; name: string } }).props;
    return { type: entity.entityType as PostgresEntityType, ...(p.schema ? { schema: p.schema } : {}), name: p.name };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The entity type a statement declares. */
function entityTypeOf(node: StatementNode): PostgresEntityType | undefined {
  switch (node.statement) {
    case "view":
      return node.materialized ? POSTGRES_ENTITY_TYPES.materializedView : POSTGRES_ENTITY_TYPES.view;
    case "grant":
      return node.defaults ? POSTGRES_ENTITY_TYPES.defaultPrivileges : POSTGRES_ENTITY_TYPES.grant;
    case "comment":
    case "rowSecurity":
      return undefined;
    default:
      return (POSTGRES_ENTITY_TYPES as Record<string, PostgresEntityType>)[node.statement];
  }
}

type NameOf = (tokens: Token[], n: NameNode) => string[];
type Qualify = (pieces: readonly string[]) => { schema?: string; name: string };
const qkey = (q: { schema?: string; name: string }) => `${q.schema ?? ""}.${q.name}`;

/** The key a created object is found under by the statements folded into it. */
function ownerKey(node: StatementNode, tokens: Token[], nameOf: NameOf, qualify: Qualify): string | undefined {
  switch (node.statement) {
    case "schema":
      return node.name ? `schema ${nameOf(tokens, node.name).at(-1) ?? ""}` : undefined;
    case "extension":
      return `extension ${nameOf(tokens, node.name).at(-1) ?? ""}`;
    case "role":
      return `role ${nameOf(tokens, node.name).at(-1) ?? ""}`;
    case "index": {
      // An index is in its table's schema.
      const table = nameOf(tokens, node.table);
      return node.name ? `index ${qkey(qualify([...table.slice(0, -1), nameOf(tokens, node.name).at(-1) ?? ""]))}` : undefined;
    }
    case "trigger":
    case "policy":
      return `${node.statement} ${nameOf(tokens, node.name).at(-1) ?? ""} ON ${qkey(qualify(nameOf(tokens, node.table)))}`;
    case "grant":
    case "comment":
    case "rowSecurity":
      return undefined;
    default:
      return `rel ${qkey(qualify(nameOf(tokens, node.name)))}`;
  }
}

/** The key of the object a COMMENT ON or ALTER TABLE ... ROW LEVEL SECURITY finishes. */
function followOnOwner(node: StatementNode, tokens: Token[], nameOf: NameOf, qualify: Qualify): string | undefined {
  if (node.statement === "rowSecurity") return `rel ${qkey(qualify(nameOf(tokens, node.table)))}`;
  if (node.statement !== "comment") return undefined;
  const target = nameOf(tokens, node.target);
  switch (node.objectType) {
    case "SCHEMA":
      return `schema ${target.at(-1) ?? ""}`;
    case "EXTENSION":
      return `extension ${target.at(-1) ?? ""}`;
    case "ROLE":
      return `role ${target.at(-1) ?? ""}`;
    case "INDEX":
      return `index ${qkey(qualify(target))}`;
    case "COLUMN":
      return `rel ${qkey(qualify(target.slice(0, -1)))}`;
    case "TRIGGER":
    case "POLICY":
      return node.on ? `${node.objectType.toLowerCase()} ${target.at(-1) ?? ""} ON ${qkey(qualify(nameOf(tokens, node.on)))}` : undefined;
    case "CONSTRAINT":
    case "DOMAIN CONSTRAINT":
      return node.on ? `rel ${qkey(qualify(nameOf(tokens, node.on)))}` : undefined;
    default:
      return `rel ${qkey(qualify(target))}`;
  }
}

/** The statement's tokens with `schema.` inserted before each marked one. */
function rewrite(tokens: readonly Token[], inserts: ReadonlySet<number>, schema: string | undefined): Token[] {
  if (!schema || inserts.size === 0) return [...tokens];
  const out: Token[] = [];
  tokens.forEach((t, i) => {
    if (inserts.has(i)) out.push({ kind: "ident", text: `${quoteBare(schema)}.`, part: 0, start: 0, end: 0 });
    out.push(t);
  });
  return out;
}

/** `ALTER TABLE [IF EXISTS] [ONLY] <name> ADD <table constraint>`: the table's name pieces and the constraint's text. */
function readAlterAdd(stmt: readonly Token[], sig: readonly Token[]): { table: string[]; constraint: string } | undefined {
  let i = 2;
  if (word(sig[i], "IF") && word(sig[i + 1], "EXISTS")) i += 2;
  if (word(sig[i], "ONLY")) i++;
  const table: string[] = [];
  for (let t = sig[i]; t && isName(t); t = sig[i]) {
    table.push(identValue(t));
    i++;
    const dot = sig[i];
    if (dot?.kind === "punct" && dot.text === ".") i++;
    else break;
  }
  if (table.length === 0 || !word(sig[i], "ADD")) return undefined;
  i++;
  if (!word(sig[i], "CONSTRAINT", "FOREIGN", "UNIQUE", "PRIMARY", "CHECK", "EXCLUDE")) return undefined;
  // One constraint: a comma at depth 0 starts another ALTER action, which is not read.
  let depth = 0;
  for (const t of sig.slice(i)) {
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")") depth--;
    else if (t.kind === "punct" && t.text === "," && depth === 0) return undefined;
  }
  const start = sig[i];
  return start ? { table, constraint: tokensText(stmt.slice(stmt.indexOf(start))) } : undefined;
}

/** Qualifies the table a folded FOREIGN KEY references, when it is unqualified. */
function qualifyConstraint(constraint: string, schema: string | undefined): string {
  if (!schema) return constraint;
  const tokens = tokenizeText(constraint, 0);
  const sig = tokens.map((t, i) => ({ t, i })).filter((x) => !isTrivia(x.t));
  const inserts = new Set<number>();
  sig.forEach((x, k) => {
    const target = sig[k + 1];
    const dot = sig[k + 2]?.t;
    if (word(x.t, "REFERENCES") && target && isName(target.t) && !(dot?.kind === "punct" && dot.text === ".")) inserts.add(target.i);
  });
  return tokensText(rewrite(tokens, inserts, schema));
}

/** A CREATE TABLE with table constraints added at the end of its column list (the `)` matching the first `(`). */
function addConstraints(create: readonly Token[], constraints: readonly string[]): string {
  let depth = 0;
  const close = create.findIndex((t) => {
    if (t.kind !== "punct") return false;
    if (t.text === "(") depth++;
    else if (t.text === ")") return --depth === 0;
    return false;
  });
  if (close < 0) return tokensText(create);
  const before = tokensText(create.slice(0, close)).replace(/\s+$/, "");
  const indent = /\n([ \t]+)\S[^\n]*$/.exec(before)?.[1] ?? "  ";
  return `${before}${constraints.map((c) => `,\n${indent}${c}`).join("")}\n${tokensText(create.slice(close))}`;
}
