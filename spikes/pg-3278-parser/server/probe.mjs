/**
 * Spike (#3278): what a scratch Postgres server says, as the lint backstop and
 * as the check that the folded DDL is valid. Runs in a scratch directory with
 * `pg` installed (not a repo dependency), holding a Docker slot:
 *
 *   .docker-slot.sh pg-3278-parser -- node probe.mjs <dir with src.sql and edge.sql>
 *
 * 1. Applies the example's postgres.sql (users/orders/order_totals) and the
 *    edge cases' in order, each statement in its own transaction.
 * 2. Sends invalid statements and records the server's message, SQLSTATE and
 *    position (the protocol's P field, a 1-based character index), for syntax
 *    errors and for errors only the catalog can find.
 * 3. Reads back the canonical forms import would see (pg_get_viewdef,
 *    format_type, pg_get_constraintdef, pg_get_indexdef, column defaults).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const IMAGE = "postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722";
const dir = process.argv[2];
const name = `pg3278-probe-${process.pid}`;
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8" }).trim();

docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=spike", "-p", "127.0.0.1::5432", IMAGE);
try {
  const port = docker("port", name, "5432/tcp").split(":").pop();
  let client;
  for (let i = 0; i < 60; i++) {
    try {
      client = new pg.Client({ host: "127.0.0.1", port: Number(port), user: "postgres", password: "spike", database: "postgres" });
      await client.connect();
      await client.query("select 1");
      break;
    } catch {
      client = undefined;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!client) throw new Error("server did not come up");
  console.log("server:", (await client.query("select version()")).rows[0].version);

  for (const f of ["src.sql", "edge.sql"]) {
    const statements = readFileSync(join(dir, f), "utf8").split(/;\n\n|;\n$/).map((s) => s.trim()).filter(Boolean);
    let ok = 0;
    for (const s of statements) {
      try {
        await client.query(s);
        ok++;
      } catch (e) {
        console.log(`  ${f}: FAILED ${e.message}\n    ${s.slice(0, 120)}`);
      }
    }
    console.log(`${f}: ${ok}/${statements.length} statements applied`);
  }

  const probes = [
    ["syntax: misspelt key word", "CREATE TABLE broken (\n  id bigint PRIMARY KEY,\n  name text NOT NULL DEFAULT 'x' CHEK (name <> '')\n)"],
    ["syntax: missing comma", "CREATE TABLE broken (id bigint PRIMARY KEY name text)"],
    ["syntax: in a view's query", "CREATE VIEW v AS SELECT id FRM app.users"],
    ["catalog: unknown type", "CREATE TABLE broken (id bigintt)"],
    ["catalog: unknown referenced table", "CREATE TABLE broken (user_id bigint REFERENCES app.nope (id))"],
    ["catalog: unknown column in an index", "CREATE INDEX broken_idx ON app.orders (nope)"],
    ["catalog: unknown column in a view", "CREATE VIEW v AS SELECT nope FROM app.users"],
    ["catalog: ambiguous column in a view", "CREATE VIEW v AS SELECT id FROM app.users u JOIN app.orders o ON o.user_id = u.id"],
    ["catalog: volatile generated column", "CREATE TABLE broken (a timestamptz, b timestamptz GENERATED ALWAYS AS (a + interval '1 day') STORED)"],
    ["catalog: index name qualified", "CREATE INDEX app.broken_idx ON app.orders (amount)"],
    ["catalog: CONCURRENTLY in a transaction", "BEGIN; CREATE INDEX CONCURRENTLY c_idx ON app.orders (amount); COMMIT"],
  ];
  console.log("\n| probe | SQLSTATE | position | message |");
  console.log("|---|---|---|---|");
  for (const [what, sql] of probes) {
    try {
      await client.query(sql);
      console.log(`| ${what} | accepted | | |`);
    } catch (e) {
      const at = e.position ? `${e.position} ('${sql.slice(Number(e.position) - 1, Number(e.position) + 5).replace(/\n/g, " ")}')` : "none";
      console.log(`| ${what} | ${e.code} | ${at} | ${e.message}${e.hint ? ` (hint: ${e.hint})` : ""} |`);
      await client.query("ROLLBACK").catch(() => {});
    }
  }

  const canon = [
    ["view", "select pg_get_viewdef('app.order_totals'::regclass, true) as v"],
    ["columns", "select attname, format_type(atttypid, atttypmod) as type, pg_get_expr(d.adbin, d.adrelid) as dflt, attidentity from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where attrelid = 'app.orders'::regclass and attnum > 0 order by attnum"],
    ["constraints", "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'app.orders'::regclass order by conname"],
    ["index", "select pg_get_indexdef('app.orders_user_id_idx'::regclass) as def"],
    ["comment", "select obj_description('app.users'::regclass, 'pg_class') as t, col_description('app.users'::regclass, 2) as c"],
  ];
  for (const [what, q] of canon) console.log(`\n${what}:`, JSON.stringify((await client.query(q)).rows, null, 1));
  await client.end();
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  console.log(`\ncleanup: ${docker("ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}") || "container removed"}`);
}
