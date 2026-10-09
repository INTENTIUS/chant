/**
 * Planning against a live Postgres server (#3279): the getting-started example
 * applied as built plans with no changes and reads back with no drift; a view
 * written as `SELECT *`, which the server expands, plans with no change
 * through the server backstop; and changes made on the server are reported
 * with their rules.
 *
 * Needs Docker; skips cleanly without it. One throwaway `postgres` container
 * at the pin, removed afterwards even on failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { planPgAgainstServer } from "./commands";
import { observeResourcesDeep } from "./deep";
import { sqlPlugin } from "../../plugin";
import { POSTGRES_DDL_FILE, sqlSerializer } from "../../serializer";
import * as pg from "../entities";

const enabled = await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-plan-"));
let server: TestPostgres | undefined;

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const profile = (db = "postgres") => ({
  config: { sql: { profiles: { e2e: { url: server!.endpoint(db).url, password: { env: "PG_E2E_PASSWORD" } } } } },
  env: { PG_E2E_PASSWORD: server!.endpoint(db).password },
});

describe.skipIf(!enabled)("planning the getting-started example against a server", () => {
  test("applied as declared, it plans with no changes and reads back with no drift; changes on the server are classified", async () => {
    const result = await build(join(import.meta.dirname, "..", "..", "..", "examples", "postgres-getting-started", "src"), [sqlSerializer], undefined, {
      fold: true,
      intrinsics: sqlPlugin.intrinsics!(),
      lexicons: ["sql"],
    });
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("sql") as SerializerResult;
    const file = join(dir, "schema.json");
    writeFileSync(file, out.primary);
    const client = await server!.connect();
    await client.query(out.files![POSTGRES_DDL_FILE]!);

    expect((await planPgAgainstServer("e2e", file, profile())).changes).toEqual([]);

    const entities = new Map([...result.entities].map(([k, v]) => [k, { entityType: v.entityType, props: (v as unknown as { props: Record<string, unknown> }).props }]));
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...profile() });
    expect(deep.unobserved ?? {}).toEqual({});
    for (const [name, e] of entities) {
      const strip = (p: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !["ddl", "source", "lineage", "reads", "concurrently"].includes(k))), (_k, v: unknown) =>
        v !== null && typeof v === "object" && "sqlName" in (v as object) && "entityType" in (v as object) ? (v as { sqlName: string }).sqlName : v);
      expect(JSON.parse(strip(deep.resources[name]!.properties)), name).toEqual(JSON.parse(strip(e.props)));
    }

    await client.query("ALTER TABLE app.orders ADD COLUMN note text; COMMENT ON TABLE app.users IS 'Changed'; ALTER TABLE app.orders ALTER COLUMN invoice_no TYPE numeric");
    const plan = await planPgAgainstServer("e2e", file, profile());
    expect(plan.changes.map((c) => [c.object, c.field, c.rule])).toEqual([
      ["users (app.users)", "comment", "SQLPG216"],
      ["orders (app.orders)", "columns.invoice_no.type", "SQLPG207"],
      ["orders (app.orders)", "columns.note", "SQLPG204"],
    ]);
    await client.end();
  }, 600_000);

  test("a view written as SELECT *, expanded by the server, plans with no change", async () => {
    const admin = await server!.connect();
    await admin.query("CREATE DATABASE star");
    await admin.end();
    const items = pg.table`CREATE TABLE public.items (id bigint PRIMARY KEY, name text, price numeric CHECK (price > 0 AND price < 1000))`;
    const all = pg.view`CREATE VIEW public.all_items AS SELECT * FROM ${items} WHERE ${items.columns.price} > 1`;
    const out = sqlSerializer.serialize(new Map<string, unknown>([["items", items], ["allItems", all]]) as never) as SerializerResult;
    const file = join(dir, "star.json");
    writeFileSync(file, out.primary);
    const client = await server!.connect("star");
    await client.query(out.files![POSTGRES_DDL_FILE]!);
    await client.end();
    expect((await planPgAgainstServer("e2e", file, profile("star"))).changes.map((c) => `${c.field}: ${c.before} -> ${c.after}`)).toEqual([]);
  }, 600_000);

  test("a column renamed by expand and contract, last on the server, plans and reads back with no drift (sql-yodeler#47)", async () => {
    const admin = await server!.connect();
    await admin.query("CREATE DATABASE renamed");
    await admin.end();
    const orders = pg.table`CREATE TABLE public.orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text NOT NULL, -- previously: customer_email
      status text DEFAULT 'placed'::text NOT NULL,
      refunded_at timestamp with time zone
    )`;
    const out = sqlSerializer.serialize(new Map<string, unknown>([["orders", orders]]) as never) as SerializerResult;
    const file = join(dir, "renamed.json");
    writeFileSync(file, out.primary);
    const client = await server!.connect("renamed");
    await client.query(
      "CREATE TABLE public.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_email text NOT NULL, status text DEFAULT 'placed'::text NOT NULL, refunded_at timestamp with time zone);" +
        "ALTER TABLE public.orders ADD COLUMN email text; UPDATE public.orders SET email = customer_email; ALTER TABLE public.orders ALTER COLUMN email SET NOT NULL; ALTER TABLE public.orders DROP COLUMN customer_email",
    );
    expect((await planPgAgainstServer("e2e", file, profile("renamed"))).changes).toEqual([]);

    const props = (orders as unknown as { props: Record<string, unknown> }).props;
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: ["orders"], entities: new Map([["orders", { entityType: "Postgres::Table", props }]]), ...profile("renamed") });
    expect(deep.resources.orders!.properties.columns).toEqual(props.columns);
    await client.end();
  }, 600_000);

  test("a serial table plans with no changes after apply; serial to bigserial is integer to bigint, unqualified", async () => {
    const admin = await server!.connect();
    await admin.query("CREATE DATABASE serials");
    await admin.end();
    const build = (type: string, name: string) => {
      const items = pg.table`CREATE TABLE public.items (id serial PRIMARY KEY, n smallserial, v text)`;
      const wide = pg.table`CREATE TABLE public.items (id bigserial PRIMARY KEY, n smallserial, v text)`;
      const out = sqlSerializer.serialize(new Map<string, unknown>([["items", type === "serial" ? items : wide]]) as never) as SerializerResult;
      const file = join(dir, name);
      writeFileSync(file, out.primary);
      return { file, ddl: out.files![POSTGRES_DDL_FILE]! };
    };
    const v1 = build("serial", "serial-v1.json");
    const v2 = build("bigserial", "serial-v2.json");
    const client = await server!.connect("serials");
    await client.query(v1.ddl);
    expect((await planPgAgainstServer("e2e", v1.file, profile("serials"))).changes).toEqual([]);

    const plan = await planPgAgainstServer("e2e", v2.file, profile("serials"));
    expect(plan.changes.map((c) => [c.field, c.rule, c.before, c.after])).toEqual([["columns.id.type", "SQLPG207", "serial", "bigserial"]]);
    expect(plan.changes[0]!.note).toContain("sequence is widened to bigint");
    await client.end();
  }, 600_000);
});
