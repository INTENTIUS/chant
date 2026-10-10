/**
 * A file of ClickHouse DDL as the objects it declares: one per `CREATE
 * DATABASE`, `TABLE`, `VIEW`, `MATERIALIZED VIEW`, `DICTIONARY` or `FUNCTION`, as `chant import
 * <file>.sql` reads them. Any other statement, and any statement the parser
 * refuses, is a problem naming it.
 *
 * With `schema` (a database), an object's unqualified name is qualified with
 * it; a function belongs to no database and keeps its name.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isTrivia, tokenizeText } from "../clickhouse/tokens";
import { parseCreate } from "../clickhouse/parser";
import { database, dictionary, func, table, view } from "../clickhouse/entities";
import { CLICKHOUSE_TAG_OF } from "../clickhouse/import/generator";
import { describeStatement, type ImportedObject } from "../clickhouse/import/ir";
import { firstLine, quoteBare, splitTokens, tokensText, type ReadOptions } from "./common";

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Declarable;
const TAGS: Record<string, Tag> = { database, table, view, dictionary, func };

/** The tag that declares an entity type. */
export function clickhouseTag(type: string): Tag | undefined {
  const name = CLICKHOUSE_TAG_OF[type];
  return name ? TAGS[name] : undefined;
}

/** The objects a file of ClickHouse DDL declares. Problems are collected, not thrown, so a file is reported whole. */
export function readClickHouse(ddl: string, options: ReadOptions, problems: string[]): ImportedObject[] {
  const objects: ImportedObject[] = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0), isTrivia)) {
    let sql = tokensText(stmt);
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
      objects.push(describeStatement(sql));
    } catch (e) {
      problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
    }
  }
  return objects;
}
