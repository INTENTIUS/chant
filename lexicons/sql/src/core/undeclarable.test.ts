/**
 * Import never leaves an object out without a word (#3911): an object of a
 * kind no declaration holds fails the import, which names every one, and
 * `skipUndeclarable` turns the failure into a warning per object. Against
 * fakes; the e2e tests (`../postgres/live/undeclarable.e2e.test.ts`,
 * `../clickhouse/live/undeclarable.e2e.test.ts`) run the same against servers.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fakeClient, type FakeCatalog } from "../postgres/testing/fake-client";
import { fakeClickHouse, type FakeServer } from "../clickhouse/testing/fake-server";
import { exportResources as exportClickHouse } from "../clickhouse/import/live-export";
import { SqlFileParser } from "../import-parser";
import { UndeclarableObjectsError } from "./undeclarable";

const pg: { catalog: FakeCatalog; provider?: string } = { catalog: {} };

vi.mock("../postgres/live/bind", async (orig) => ({
  ...(await orig<typeof import("../postgres/live/bind")>()),
  bindPostgres: async () => ({
    target: { endpoint: { url: "postgres://x/db" }, source: "test", defaultSchema: "public", ...(pg.provider ? { provider: pg.provider } : {}) },
    client: fakeClient(pg.catalog),
  }),
}));

const { exportResources: exportPostgres } = await import("../postgres/import/live-export");

const CATALOG: FakeCatalog = {
  schemas: [{ name: "app" }],
  tables: [{ schema: "app", name: "users", columns: [{ name: "id", type: "bigint", notnull: true }] }],
  undeclarable: [
    { kind: "access method", name: "heap2" },
    { kind: "conversion", schema: "app", name: "latin1_utf8" },
    { kind: "rule", schema: "app", name: "users_notify ON users" },
    { kind: "base type", schema: "app", name: "later" },
  ],
};

describe("Postgres live import", () => {
  test("fails naming every object of a kind chant cannot declare, and why", async () => {
    pg.catalog = CATALOG;
    const err = await exportPostgres({ environment: "prod" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UndeclarableObjectsError);
    const message = (err as Error).message;
    for (const line of ["  - access method heap2", "  - conversion app.latin1_utf8", "  - rule app.users_notify ON users", "  - base type app.later"]) {
      expect(message).toContain(line);
    }
    expect(message).toContain("  - conversion: no tag declares an encoding conversion");
    expect(message).toContain("--skip-undeclarable");
  });

  test("with skipUndeclarable, imports the rest and warns once per object", async () => {
    pg.catalog = CATALOG;
    const ir = await exportPostgres({ environment: "prod", skipUndeclarable: true });
    expect(ir.resources.map((r) => r.properties.name)).toContain("users");
    const left = (ir.warnings ?? []).filter((w) => w.includes("is left out (--skip-undeclarable)"));
    expect(left).toHaveLength(4);
    expect(left[0]).toBe("access method heap2 is left out (--skip-undeclarable): no tag declares an access method; an extension usually installs one, and the extension is declared instead");
  });

  test("a selector or owned import does not look", async () => {
    pg.catalog = CATALOG;
    await expect(exportPostgres({ environment: "prod", selector: { type: "Postgres::Table" } })).resolves.toBeDefined();
    await expect(exportPostgres({ environment: "prod", owned: true })).resolves.toBeDefined();
  });

  test("a managed provider's own objects are its, with a warning, not a refusal", async () => {
    pg.catalog = { ...CATALOG, undeclarable: [{ kind: "conversion", schema: "auth", name: "x" }] };
    pg.provider = "supabase";
    try {
      const ir = await exportPostgres({ environment: "prod" });
      expect(ir.warnings).toContain("conversion auth.x is kept by Supabase; left out");
    } finally {
      pg.provider = undefined;
    }
  });
});

describe("ClickHouse live import", () => {
  let server: FakeServer;
  beforeAll(async () => {
    server = await fakeClickHouse(
      [
        { name: "analytics", engine: "Atomic", statement: "CREATE DATABASE analytics\nENGINE = Atomic" },
        { database: "analytics", name: "events", engine: "MergeTree", statement: "CREATE TABLE analytics.events\n(\n    `id` UInt64\n)\nENGINE = MergeTree\nORDER BY id" },
        { database: "analytics", name: "wv", engine: "WindowView", statement: "CREATE WINDOW VIEW analytics.wv AS SELECT 1" },
      ],
      {
        undeclarable: [
          { kind: "named collection", name: "nc1" },
          { kind: "workload", name: "all" },
          { kind: "window view", database: "analytics", name: "wv" },
        ],
      },
    );
  });
  afterAll(() => server.close());
  const run = (extra: Record<string, unknown> = {}) => exportClickHouse({ environment: "x", config: {}, env: { CLICKHOUSE_URL: server.url }, ...extra });

  test("fails naming them", async () => {
    await expect(run()).rejects.toThrow(/  - named collection nc1\n  - window view analytics\.wv\n  - workload all\n/);
  });

  test("with skipUndeclarable, warns, and the window view is not imported as a table", async () => {
    const ir = await run({ skipUndeclarable: true });
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["analytics", "events"]);
    expect((ir.warnings ?? []).filter((w) => w.includes("--skip-undeclarable"))).toHaveLength(3);
  });
});

describe("file import", () => {
  const DDL = `CREATE SCHEMA app;
CREATE TABLE app.t (id int PRIMARY KEY);
CREATE AGGREGATE app.total(int) (sfunc = int4pl, stype = int);
CREATE CONVERSION app.latin1_utf8 FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8;
CREATE TYPE app.pair AS (a int, b text);
CREATE TYPE app.later;
CREATE COLLATION app.ci (provider = icu, locale = 'und');`;

  test("a CREATE of a kind chant cannot declare is an error naming it", () => {
    expect(() => new SqlFileParser("postgres").parse(DDL)).toThrow(/conversion: chant cannot declare it \(no tag declares an encoding conversion\): CREATE CONVERSION app\.latin1_utf8/);
  });

  test("skipUndeclarable imports the rest and lists them as warnings", () => {
    const ir = new SqlFileParser("postgres", { skipUndeclarable: true }).parse(DDL);
    // An aggregate, a composite type and a collation are declared kinds (#3911): imported, not refused.
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["app", "t", "total", "pair", "ci"]);
    expect(ir.warnings).toEqual([
      "left out (skipUndeclarable): conversion: chant cannot declare it (no tag declares an encoding conversion): CREATE CONVERSION app.latin1_utf8 FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8",
      "left out (skipUndeclarable): base type: chant cannot declare it (no tag declares a base type; its input and output functions are C code an extension installs): CREATE TYPE app.later",
    ]);
  });

  test("ClickHouse: a named collection in a file is refused too; a quota is declared (#3911)", () => {
    expect(() => new SqlFileParser("clickhouse").parse("CREATE DATABASE a;\nCREATE NAMED COLLECTION c AS url = 'x'")).toThrow(/named collection: chant cannot declare it/);
    expect(new SqlFileParser("clickhouse").parse("CREATE DATABASE a;\nCREATE QUOTA q1").resources.map((r) => r.type)).toEqual(["ClickHouse::Database", "ClickHouse::Quota"]);
  });
});
