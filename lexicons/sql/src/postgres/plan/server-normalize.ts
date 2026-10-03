/**
 * The backstop for normalization against a live server: what the rules in
 * `./normalize.ts` cannot see (a view's `SELECT *`, which the server expands;
 * the parentheses it adds inside a check) is asked of the server itself.
 *
 * For each declared table or view whose expressions still differ from the
 * server's, the declaration's expressions are created as a temporary object
 * (`CREATE TEMP VIEW`, or a `CREATE TEMP TABLE` holding the columns' types,
 * defaults and generated expressions and the checks) inside a transaction
 * that is always rolled back, with a short `lock_timeout`, and read back with
 * the same printers the catalog read uses. Nothing is left behind: Postgres
 * DDL is transactional and a temporary object lives in the session's own
 * schema. A server that refuses (no TEMP privilege, a lock not granted in
 * time, an expression it rejects) leaves the rules' answer standing.
 */

import type { PostgresClient } from "../live/client";
import { quoteIdent } from "../keywords";
import { canonicalExpr, type CanonicalPgObject } from "./normalize";

type Row = Record<string, unknown>;

async function rolledBack<T>(client: PostgresClient, defaultSchema: string, body: () => Promise<T>): Promise<T | undefined> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [quoteIdent(defaultSchema)]);
    return await body();
  } catch {
    return undefined;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

const emptyPath = (client: PostgresClient) => client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);

/** A view's query as the server prints it, canonical, and its output columns. */
async function viewQuery(client: PostgresClient, query: string, defaultSchema: string): Promise<{ query: string; outputs: string[] } | undefined> {
  return rolledBack(client, defaultSchema, async () => {
    await client.query(`CREATE TEMP VIEW chant_normalize AS ${query}`);
    await emptyPath(client);
    const [row] = await client.query<Row>(`SELECT pg_catalog.pg_get_viewdef('pg_temp.chant_normalize'::pg_catalog.regclass, true) AS def`);
    const cols = await client.query<Row>(
      `SELECT a.attname AS name FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'pg_temp.chant_normalize'::pg_catalog.regclass AND a.attnum > 0 ORDER BY a.attnum`,
    );
    return { query: canonicalExpr(String(row?.def ?? "").trim().replace(/;$/, ""))!, outputs: cols.map((c) => String(c.name)) };
  });
}

/** A table's defaults, generated expressions and checks as the server prints them, canonical. */
async function tableExpressions(client: PostgresClient, o: CanonicalPgObject, defaultSchema: string): Promise<{ defaults: Map<string, string>; generated: Map<string, string>; checks: string[] } | undefined> {
  const columns = o.columns.filter((c) => c.type !== undefined);
  if (columns.length === 0) return undefined;
  const defs = columns.map((c) => {
    const type = /^(small|big)?serial$/.test(c.type!) ? c.type!.replace("serial", "int").replace("smallint", "smallint").replace(/^int$/, "integer") : c.type!;
    const parts = [quoteIdent(c.name), type];
    if (c.collate) parts.push(`COLLATE ${c.collate}`);
    if (c.generated) {
      const [kind, ...expr] = c.generated.split(" ");
      parts.push(`GENERATED ALWAYS AS (${expr.join(" ")}) ${kind === "virtual" ? "VIRTUAL" : "STORED"}`);
    } else if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
    return parts.join(" ");
  });
  const checks = o.constraints.filter((c) => c.kind === "CHECK").map((c, i) => `CONSTRAINT chant_check_${String(i).padStart(4, "0")} ${c.body.replace(/^check /, "CHECK (").replace(/( no inherit| not enforced)*$/, ")$&")}`);
  return rolledBack(client, defaultSchema, async () => {
    await client.query(`CREATE TEMP TABLE chant_normalize (${[...defs, ...checks].join(", ")})`);
    await emptyPath(client);
    const cols = await client.query<Row>(
      `SELECT a.attname AS name, a.attgenerated AS generated, pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS expr
       FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'pg_temp.chant_normalize'::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const cons = await client.query<Row>(
      `SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid, true) AS def FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'pg_temp.chant_normalize'::pg_catalog.regclass AND c.contype = 'c' ORDER BY c.conname`,
    );
    const defaults = new Map<string, string>();
    const generated = new Map<string, string>();
    for (const r of cols) {
      if (r.expr === null || r.expr === undefined) continue;
      if (r.generated === "s" || r.generated === "v") generated.set(String(r.name), `${r.generated === "s" ? "stored" : "virtual"} ${canonicalExpr(String(r.expr))}`);
      else defaults.set(String(r.name), canonicalExpr(String(r.expr))!);
    }
    const printed = cons.map((r) => String(r.def).replace(/^CHECK /, "")).map((d) => canonicalExpr(d)!);
    return { defaults, generated, checks: printed };
  });
}

/**
 * The declared object with its expressions in the server's own printing,
 * when the server answers; the object unchanged otherwise. Only the
 * expressions are touched: everything else stays the rules'.
 */
export async function serverNormalized<T extends CanonicalPgObject & { outputs?: string[] }>(client: PostgresClient, o: T, defaultSchema: string): Promise<T> {
  if ((o.kind === "view" || o.kind === "materializedView") && typeof o.fields.query === "string") {
    const q = await viewQuery(client, o.fields.query, defaultSchema);
    // A declared column list names the outputs; otherwise the server's names do (`SELECT *` expanded).
    return q === undefined ? o : { ...o, fields: { ...o.fields, query: q.query }, ...(o.fields.columns === undefined ? { outputs: q.outputs } : {}) };
  }
  if (o.kind === "table") {
    const e = await tableExpressions(client, o, defaultSchema);
    if (!e) return o;
    let i = 0;
    return {
      ...o,
      columns: o.columns.map((c) => ({
        ...c,
        ...(c.default !== undefined && e.defaults.has(c.name) && !/^(small|big)?serial$/.test(c.type ?? "") ? { default: e.defaults.get(c.name) } : {}),
        ...(c.generated !== undefined && e.generated.has(c.name) ? { generated: e.generated.get(c.name) } : {}),
      })),
      constraints: o.constraints.map((c) => {
        if (c.kind !== "CHECK") return c;
        const printed = e.checks[i++];
        if (printed === undefined) return c;
        const tail = /( no inherit| not enforced)*$/.exec(c.body)?.[0] ?? "";
        return { ...c, body: `check ${printed}${tail}` };
      }),
    };
  }
  return o;
}
