import { describe, expect, test } from "vitest";
import { environmentOf, receiptDialect, sqlReceiptStore } from "./receipts";
import type { PostgresClient } from "./postgres/live/client";

const ref = (effect: string) => ({ name: effect, effect, flavor: "existence" as const, inputs: {} });

/** A Postgres client that records each statement and answers the store's catalog reads. */
function fakePostgres(state: { schema?: boolean; table?: string | null } = {}) {
  const statements: string[] = [];
  let schema = state.schema ?? false;
  let table: string | null | undefined = state.table;
  const rows = new Map<string, string>();
  const client: PostgresClient = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      statements.push(sql);
      if (sql.includes("pg_namespace WHERE nspname")) return [{ n: schema ? 1 : 0 }] as T[];
      if (sql.startsWith("CREATE SCHEMA")) schema = true;
      if (sql.includes("to_regclass($1) IS NOT NULL AS present")) return [{ present: table !== undefined, comment: table ?? null }] as T[];
      if (sql.startsWith("CREATE TABLE")) table = null;
      if (sql.startsWith("COMMENT ON TABLE")) table = sql.slice(sql.indexOf("IS '") + 4, -1);
      if (sql.startsWith("INSERT INTO")) rows.set(String(params[0]), String(params[2]));
      if (sql.startsWith("SELECT expectation")) {
        const v = rows.get(String(params[0]));
        return (v === undefined ? [] : [{ expectation: v }]) as T[];
      }
      return [] as T[];
    },
    end: async () => undefined,
  };
  return { client, statements, rows };
}

describe("receiptDialect (#3657)", () => {
  test("the environment's profile decides, by its URL's scheme", () => {
    const config = { sql: { profiles: { pg: { url: "postgres://db:5432/app" }, ch: { url: "http://ch:8123" } } } };
    expect(receiptDialect(config, "pg", {})).toBe("postgres");
    expect(receiptDialect(config, "ch", {})).toBe("clickhouse");
  });

  test("with no profile, sql.dialect, then whichever server variable is set", () => {
    expect(receiptDialect({ sql: { dialect: "postgres" } }, "dev", {})).toBe("postgres");
    expect(receiptDialect({ sql: { dialect: ["clickhouse"] } }, undefined, { POSTGRES_URL: "postgres://x/y" })).toBe("clickhouse");
    expect(receiptDialect(undefined, undefined, { POSTGRES_URL: "postgres://x/y" })).toBe("postgres");
    expect(receiptDialect(undefined, undefined, {})).toBe("clickhouse");
  });
});

describe("environmentOf (#3657)", () => {
  test("the option, then CHANT_ENV, then a literal ownership.env", () => {
    expect(environmentOf({ environment: "a" }, { ownership: { stack: "s", env: "c" } }, { CHANT_ENV: "b" })).toBe("a");
    expect(environmentOf({}, { ownership: { stack: "s", env: "c" } }, { CHANT_ENV: "b" })).toBe("b");
    expect(environmentOf({}, { ownership: { stack: "s", env: "c" } }, {})).toBe("c");
    expect(environmentOf({}, undefined, {})).toBeUndefined();
  });
});

describe("sqlReceiptStore over Postgres (#3657)", () => {
  test("keeps receipts in chant_receipts.receipts, a schema and table it marks as chant's", async () => {
    const pg = fakePostgres();
    const store = sqlReceiptStore({ environment: "prod", stack: "shop", postgres: pg.client, runId: "r1" });
    expect(await store.read(ref("fill/b1"))).toBeUndefined();
    await store.write(ref("fill/b1"), "present");
    expect(await store.read(ref("fill/b1"))).toBe("present");

    expect(pg.statements).toContain("CREATE SCHEMA IF NOT EXISTS chant_receipts");
    expect(pg.statements.find((s) => s.startsWith("COMMENT ON SCHEMA chant_receipts"))).toContain("receipts=effects");
    expect(pg.statements.find((s) => s.startsWith("CREATE TABLE"))).toContain("TABLE IF NOT EXISTS chant_receipts.receipts (");
    expect([...pg.rows.keys()]).toEqual(["shop/prod/fill/b1"]);
    expect(await store.location()).toEqual({ dialect: "postgres", table: "chant_receipts.receipts", source: "the caller's connection", address: "shop/prod/<effect>" });
  });

  test("a receiptsSchema keeps them in <schema>.__chant_receipts, and creates no schema", async () => {
    const pg = fakePostgres();
    const store = sqlReceiptStore({
      environment: "prod",
      postgres: pg.client,
      config: { ownership: { stack: "shop" }, sql: { profiles: { prod: { url: "postgres://db/app", receiptsSchema: "app" } } } },
    });
    await store.write(ref("fill/b1"), "present");
    expect(pg.statements.some((s) => s.includes("CREATE SCHEMA"))).toBe(false);
    expect(pg.statements.find((s) => s.startsWith("CREATE TABLE"))).toContain("TABLE IF NOT EXISTS app.__chant_receipts (");
    expect((await store.location()).table).toBe("app.__chant_receipts");
  });

  test("a table of the user's under the receipts name is refused, not written into", async () => {
    const pg = fakePostgres({ schema: true, table: "the user's own receipts" });
    const store = sqlReceiptStore({ environment: "prod", stack: "shop", postgres: pg.client });
    await expect(store.write(ref("fill/b1"), "present")).rejects.toThrow(/chant_receipts\.receipts exists and is not chant's receipts table/);
    expect(pg.rows.size).toBe(0);
  });
});
