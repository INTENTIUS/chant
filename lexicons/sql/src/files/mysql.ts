/**
 * A file of MySQL DDL as the objects it declares (#5449): one per `CREATE
 * DATABASE` (or `CREATE SCHEMA`), `CREATE TABLE` and `CREATE VIEW`, as
 * `chant import <file>.sql` and a build's `.sql` files read them. A `CREATE
 * INDEX` on a table the file creates is read into that table, as a key in
 * its `CREATE TABLE`, which is where `SHOW CREATE TABLE` prints it. Any other
 * statement, and any statement the parser refuses, is a problem naming it.
 *
 * With `schema` (a database), a table's or view's unqualified name is
 * qualified with it.
 */

import { isTrivia, tokenizeText, unquote, type Token } from "../mysql/tokens";
import { parseMysqlCreate } from "../mysql/parser";
import { describeMysqlStatement, type ImportedMysqlObject } from "../mysql/import/generator";
import { quoteIdent } from "../mysql/names";
import { declaresNothing, fileUnparsed, firstLine, lineAt, splitTokens, tokensText, undeclarableStatement, type FileLine, type ReadOptions } from "./common";

const text = (tokens: readonly Token[], from: number, to: number) => tokens.slice(from, to).map((t) => t.text).join("");

/** A `CREATE TABLE` with `element` added at the end of its element list. */
export function withElement(ddl: string, element: string): string {
  const tokens = tokenizeText(ddl, 0);
  const node = parseMysqlCreate(tokens);
  if (node.statement !== "table") return ddl;
  const open = tokens.findIndex((t, i) => i >= node.name.to && t.kind === "punct" && t.text === "(");
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.text === "(") depth++;
    else if (t.kind === "punct" && t.text === ")" && --depth === 0) {
      let before = i;
      while (before > open && isTrivia(tokens[before - 1]!)) before--;
      return `${text(tokens, 0, before)},\n  ${element}${text(tokens, before, tokens.length)}`;
    }
  }
  return ddl;
}

/** The objects a file of MySQL DDL declares. Problems are collected, not thrown, so a file is reported whole. */
export function readMysql(ddl: string, options: ReadOptions, problems: string[]): Array<ImportedMysqlObject & FileLine> {
  const objects: Array<ImportedMysqlObject & FileLine> = [];
  for (const stmt of splitTokens(tokenizeText(ddl, 0), isTrivia)) {
    let sql = tokensText(stmt);
    const line = lineAt(ddl, stmt[0]!.start);
    const undeclarable = undeclarableStatement("mysql", sql);
    if (undeclarable) {
      (options.undeclarable ?? problems).push(undeclarable);
      continue;
    }
    if (!/^CREATE\b/i.test(sql)) {
      if (options.undeclarable) options.undeclarable.push(declaresNothing(sql, line));
      else problems.push(`not a CREATE statement: ${firstLine(sql)}`);
      continue;
    }
    try {
      const tokens = tokenizeText(sql, 0);
      const node = parseMysqlCreate(tokens);
      if (node.statement === "index") {
        const parts = tokens.slice(node.table.from, node.table.to).filter((t) => !isTrivia(t) && t.text !== ".").map((t) => unquote(t.text));
        const name = parts[parts.length - 1]!;
        const database = parts.length >= 2 ? parts[parts.length - 2] : options.schema;
        const owner = objects.find((o) => o.type === "MySQL::Table" && o.name === name && o.database === database);
        if (!owner) {
          problems.push(`creates an index on ${database ? `${database}.` : ""}${name}, which the file does not create before it; declare the index in its table's CREATE TABLE: ${firstLine(sql)}`);
          continue;
        }
        // From the index word to the end, less `ON table`: a key in the table's element list.
        const kind = node.key.kind === "unique" ? "UNIQUE KEY" : node.key.kind === "fulltext" ? "FULLTEXT KEY" : node.key.kind === "spatial" ? "SPATIAL KEY" : "KEY";
        const partsAt = tokens.findIndex((t, i) => i >= node.table.to && t.kind === "punct" && t.text === "(");
        let end = tokens.length;
        for (let i = tokens.length - 1; i > partsAt; i--) {
          if (tokens[i]!.kind === "ident" && /^(ALGORITHM|LOCK)$/i.test(tokens[i]!.text)) end = i;
        }
        const key = `${kind} ${quoteIdent(node.key.name!)}${node.key.using ? ` USING ${node.key.using}` : ""} ${text(tokens, partsAt, end).trim()}`;
        owner.ddl = withElement(owner.ddl, key);
        continue;
      }
      const name = tokens.slice(node.name.from, node.name.to).filter((t) => !isTrivia(t));
      if (options.schema && node.statement !== "database" && name.length === 1) {
        const at = tokens.indexOf(name[0]!);
        sql = text(tokens, 0, at) + `${quoteIdent(options.schema)}.` + text(tokens, at, tokens.length);
      }
      const unparsed = fileUnparsed(node.unknown, tokens, sql, line);
      objects.push({ ...describeMysqlStatement(sql), line, ...(unparsed ? { unparsed } : {}) });
    } catch (e) {
      problems.push(`does not parse (${e instanceof Error ? e.message : String(e)}): ${firstLine(sql)}`);
    }
  }
  return objects;
}
