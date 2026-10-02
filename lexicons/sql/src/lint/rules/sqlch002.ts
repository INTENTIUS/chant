import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { parseCreate, unquote, type ColumnNode, type CreateNode, type Span } from "../../clickhouse/parser";
import { isTrivia, SqlSyntaxError, type Token } from "../../clickhouse/tokens";
import { findTemplates, tokenPosition, tokensOf } from "./templates";

/** The column's type, as written, reads `Nullable(...)`, also inside `LowCardinality(...)`. */
function isNullable(tokens: Token[], c: ColumnNode): boolean {
  if (c.nullable === true) return true;
  if (!c.type) return false;
  const words = tokens.slice(c.type.from, c.type.to).filter((t) => t.kind === "ident").map((t) => t.text.toLowerCase());
  return words[0] === "nullable" || (words[0] === "lowcardinality" && words[1] === "nullable");
}

/**
 * The column names a key names as a key part: bare, or inside the key's tuple
 * parentheses, not an argument of a function (`ifNull(a, '')` makes a
 * non-Nullable key part of a Nullable column) and not a qualified part.
 */
function keyColumns(tokens: Token[], span: Span): Array<{ name: string; token: Token }> {
  const sig = tokens.slice(span.from, span.to).filter((t) => !isTrivia(t));
  const out: Array<{ name: string; token: Token }> = [];
  const frames: boolean[] = []; // true for a function call's parentheses
  sig.forEach((t, i) => {
    const prev = sig[i - 1];
    if (t.kind === "punct" && t.text === "(") {
      frames.push(prev !== undefined && (prev.kind === "ident" || prev.kind === "qident"));
      return;
    }
    if (t.kind === "punct" && t.text === ")") {
      frames.pop();
      return;
    }
    if (t.kind !== "ident" && t.kind !== "qident") return;
    if (frames.includes(true)) return;
    const next = sig[i + 1];
    if (next?.kind === "punct" && next.text === "(") return;
    if (prev?.kind === "punct" && prev.text === ".") return;
    out.push({ name: unquote(t.text), token: t });
  });
  return out;
}

function allowsNullableKey(tokens: Token[], node: CreateNode): boolean {
  if (node.statement === "database" || !node.settings) return false;
  const s = node.settings.find((x) => x.key === "allow_nullable_key");
  if (!s) return false;
  const v = tokens.slice(s.value.from, s.value.to).map((t) => t.text).join("").trim().toLowerCase().replace(/'/g, "");
  return v === "1" || v === "true";
}

/**
 * SQLCH002: a `Nullable` column in a table's sort key or primary key.
 *
 * ClickHouse refuses to create the table ("Sorting key contains nullable
 * columns") unless the table sets `allow_nullable_key = 1`, and with it a
 * `NULL` sorts as a value of its own. The rule reads the types written in the
 * column list; a key over a column of an inferred type is left to the server.
 */
export const sqlch002: LintRule = {
  id: "SQLCH002",
  severity: "error",
  category: "correctness",
  description: "A Nullable column in a ClickHouse sort key or primary key",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    for (const found of findTemplates(source)) {
      const tokens = tokensOf(found);
      let node: CreateNode;
      try {
        node = parseCreate(tokens);
      } catch (err) {
        if (err instanceof SqlSyntaxError) continue; // SQLCH001 reports it
        throw err;
      }
      if (node.statement === "database" || allowsNullableKey(tokens, node)) continue;
      const nullable = new Set(node.columns.filter((c) => c.name && isNullable(tokens, c)).map((c) => c.name));
      if (nullable.size === 0) continue;
      const reported = new Set<string>();
      for (const [clause, span] of [
        ["sort key", node.orderBy],
        ["primary key", node.primaryKey],
      ] as const) {
        if (!span) continue;
        for (const { name, token } of keyColumns(tokens, span)) {
          if (!nullable.has(name) || reported.has(`${clause}:${name}`)) continue;
          reported.add(`${clause}:${name}`);
          out.push({
            ruleId: "SQLCH002",
            severity: "error",
            message:
              `column "${name}" is Nullable and is in the ${clause}; ClickHouse refuses this unless the table ` +
              "sets allow_nullable_key = 1. Make the column non-Nullable (a default such as '' or 0 in place of NULL), " +
              "or drop it from the key",
            file: context.filePath,
            ...tokenPosition(source, found, token),
          });
        }
      }
      for (const c of node.columns) {
        if (c.primaryKey && nullable.has(c.name)) {
          out.push({
            ruleId: "SQLCH002",
            severity: "error",
            message: `column "${c.name}" is Nullable and is declared PRIMARY KEY; ClickHouse refuses this unless the table sets allow_nullable_key = 1`,
            file: context.filePath,
            ...tokenPosition(source, found, tokens[c.nameSpan.from]!),
          });
        }
      }
    }
    return out;
  },
};
