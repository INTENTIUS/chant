/**
 * A file of ClickHouse DDL as the objects it declares: one per `CREATE
 * DATABASE`, `TABLE`, `VIEW`, `MATERIALIZED VIEW`, `DICTIONARY` or `FUNCTION`, as `chant import
 * <file>.sql` reads them, and one per `CREATE USER`, `CREATE ROLE`, `CREATE
 * ROW POLICY`, `CREATE QUOTA`, `CREATE SETTINGS PROFILE` (#3911) and `GRANT`
 * (#3711), each read by its tag, so what the tag
 * refuses (`IDENTIFIED BY`, a `REVOKE`) is refused with the tag's message.
 * Any other statement, and any statement the parser refuses, is a problem
 * naming it.
 *
 * With `schema` (a database), an object's unqualified name is qualified with
 * it, and so is the table a row policy or a grant is on; a function, a user
 * and a role belong to no database and keep their names.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isTrivia, tokenizeText } from "../clickhouse/tokens";
import { parseCreate } from "../clickhouse/parser";
import { CLICKHOUSE_ENTITY_TYPES, database, dictionary, func, grant, policy, quota, role, settingsProfile, table, user, view } from "../clickhouse/entities";
import { isAccessStatement, parseAccess, type AccessNode } from "../clickhouse/access";
import type { Token } from "../clickhouse/tokens";
import { CLICKHOUSE_TAG_OF } from "../clickhouse/import/generator";
import { describeStatement, type ImportedObject } from "../clickhouse/import/ir";
import { fileUnparsed, firstLine, lineAt, quoteBare, referencedStatement, splitTokens, tokensText, undeclarableStatement, type FileLine, type ReadOptions } from "./common";
import { createdCollectionName } from "../clickhouse/named-collections";
import { templateSafe, templateStrings } from "./postgres";

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Declarable;
const TAGS: Record<string, Tag> = { database, table, view, dictionary, func, user, role, policy, quota, settingsProfile, grant };

/** The tag an access statement's words name: `CREATE USER`, `CREATE SETTINGS PROFILE`, `GRANT`. */
function accessTag(words: string[]): Tag {
  if (words[0] !== "CREATE") return grant;
  return words[1] === "USER" ? user : words[1] === "ROLE" ? role : words[1] === "QUOTA" ? quota : words[1] === "SETTINGS" || words[1] === "PROFILE" ? settingsProfile : policy;
}

/** Tokens with `[db.]name`'s bare name qualified with `schema`. A `*` (all tables) is left alone. */
function qualifyBare(tokens: Token[], span: { from: number; to: number } | undefined, schema: string): string | undefined {
  if (!span) return undefined;
  const name = tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));
  const [only] = name;
  if (!only || name.length !== 1 || (only.kind !== "ident" && only.kind !== "qident")) return undefined;
  const at = tokens.indexOf(only);
  return tokensText(tokens.slice(0, at)) + `${quoteBare(schema)}.` + tokensText(tokens.slice(at));
}

/** An access statement as the object its tag declares (#3711), or the tag's refusal. */
function readAccess(sql: string, options: ReadOptions): ImportedObject | string {
  let tokens = tokenizeText(sql, 0);
  let node: AccessNode;
  try {
    node = parseAccess(tokens);
  } catch (e) {
    // What the tag refuses (a password) is refused in the tag's words.
    const tag = accessTag(sql.replace(/--[^\n]*\n/g, " ").trim().split(/\s+/, 2).map((w) => w.toUpperCase()));
    try {
      tag(templateStrings([templateSafe(sql)]));
    } catch (refused) {
      return refused instanceof Error ? refused.message : String(refused);
    }
    throw e;
  }
  if (options.schema) {
    const qualified = qualifyBare(tokens, node.statement === "rowPolicy" ? node.table : node.statement === "grant" ? node.target : undefined, options.schema);
    if (qualified !== undefined) {
      sql = qualified;
      tokens = tokenizeText(sql, 0);
      node = parseAccess(tokens);
    }
  }
  const tag = { user, role, rowPolicy: policy, quota, settingsProfile, grant }[node.statement];
  let props: { name: string; database?: string; table?: string };
  try {
    props = (tag(templateStrings([templateSafe(sql)])) as unknown as { props: typeof props }).props;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (node.statement === "user") return { type: CLICKHOUSE_ENTITY_TYPES.user, name: props.name, ddl: sql };
  if (node.statement === "role") return { type: CLICKHOUSE_ENTITY_TYPES.role, name: props.name, ddl: sql };
  if (node.statement === "quota") return { type: CLICKHOUSE_ENTITY_TYPES.quota, name: props.name, ddl: sql };
  if (node.statement === "settingsProfile") return { type: CLICKHOUSE_ENTITY_TYPES.settingsProfile, name: props.name, ddl: sql };
  if (node.statement === "rowPolicy") return { type: CLICKHOUSE_ENTITY_TYPES.rowPolicy, ...(props.database ? { database: props.database } : {}), name: props.name, ddl: sql };
  // A grant has no name of its own: what it grants, on what, to whom.
  return { type: CLICKHOUSE_ENTITY_TYPES.grant, name: `grant ${tokensText(tokens.slice(tokens.findIndex((t) => !isTrivia(t)) + 1)).replace(/\s+/g, " ").trim().toLowerCase()}`, ddl: sql };
}

/** The tag that declares an entity type. */
export function clickhouseTag(type: string): Tag | undefined {
  const name = CLICKHOUSE_TAG_OF[type];
  return name ? TAGS[name] : undefined;
}

/** The objects a file of ClickHouse DDL declares. Problems are collected, not thrown, so a file is reported whole. */
export function readClickHouse(ddl: string, options: ReadOptions, problems: string[]): Array<ImportedObject & FileLine> {
  const objects: Array<ImportedObject & FileLine> = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0), isTrivia)) {
    let sql = tokensText(stmt);
    const line = lineAt(ddl, stmt[0]!.start);
    const referenced = options.prerequisites ? referencedStatement("clickhouse", sql) : undefined;
    const collection = referenced ? createdCollectionName(sql) : undefined;
    if (referenced && collection !== undefined) {
      options.prerequisites!.push({ kind: referenced.kind, name: collection });
      continue;
    }
    const undeclarable = undeclarableStatement("clickhouse", sql);
    if (undeclarable) {
      (options.undeclarable ?? problems).push(undeclarable);
      continue;
    }
    if (isAccessStatement(sql)) {
      try {
        const read = readAccess(sql, options);
        if (typeof read === "string") problems.push(`${read}: ${firstLine(sql)}`);
        else objects.push({ ...read, line });
      } catch (e) {
        problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
      }
      continue;
    }
    if (!/^CREATE\b/i.test(sql)) {
      problems.push(`not a CREATE statement: ${firstLine(sql)}`);
      continue;
    }
    try {
      const tokens = tokenizeText(sql, 0);
      const node = parseCreate(tokens);
      const name = tokens.slice(node.name.from, node.name.to).filter((t) => !isTrivia(t));
      const [only] = name;
      if (options.schema && node.statement !== "database" && node.statement !== "function" && only && name.length === 1) {
        const at = tokens.indexOf(only);
        sql = tokensText(tokens.slice(0, at)) + `${quoteBare(options.schema)}.` + tokensText(tokens.slice(at));
      }
      const unparsed = fileUnparsed(node.unknown, tokens, sql, line);
      objects.push({ ...describeStatement(sql), line, ...(unparsed ? { unparsed } : {}) });
    } catch (e) {
      problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
    }
  }
  return objects;
}
