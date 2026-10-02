/**
 * The backstop for normalization against a live server: for each changed
 * expression the rules leave different, ask the server to format both sides
 * (`formatQuerySingleLine`, which parses and prints and touches nothing) and
 * drop the change when they print the same. `a+b*2` and `a + (b * 2)` are one
 * expression to the server.
 */

import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import type { Change } from "./diff";

const EXPRESSION_FIELDS = /^(orderBy|primaryKey|partitionBy|sampleBy|select|columns\.[^.]+\.(default|ttl)|indexes\..+|projections\..+)$/;

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function asQuery(field: string, text: string): string {
  if (field === "select") return text;
  if (field.endsWith(".default")) return `SELECT ${text.replace(/^(DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL) /, "")}`;
  return `SELECT ${text}`;
}

/** The changes that remain once the server's formatter has had its say. */
export async function dropFormattingOnly(endpoint: ClickHouseEndpoint, changes: Change[]): Promise<Change[]> {
  const candidates = changes.filter((c) => EXPRESSION_FIELDS.test(c.field) && c.before !== undefined && c.after !== undefined);
  if (candidates.length === 0) return changes;
  const same = new Set<Change>();
  for (const c of candidates) {
    try {
      const [row] = await clickhouseQuery<{ a: string; b: string }>(
        endpoint,
        `SELECT formatQuerySingleLine(${quote(asQuery(c.field, c.before!))}) AS a, formatQuerySingleLine(${quote(asQuery(c.field, c.after!))}) AS b`,
      );
      if (row && row.a === row.b) same.add(c);
    } catch {
      // The server could not parse one side as a query: the rules' answer stands.
    }
  }
  return changes.filter((c) => !same.has(c));
}
