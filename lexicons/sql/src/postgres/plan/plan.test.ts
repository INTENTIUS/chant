import { describe, expect, test } from "vitest";
import { diffPgSchemas, type PgSchemaDiff } from "./diff";
import { diffObject, keyedByQualifiedName, renameHints, type PgSchemaObject } from "./schema";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffPgBuildFiles } from "./commands";
import { renderPgDiff } from "./report";
import { classifyPgDisruption } from "./disruption";
import { PG_CLASSIFIER_RULES } from "./rules";

const TYPES: Record<string, string> = {
  table: "Postgres::Table",
  index: "Postgres::Index",
  view: "Postgres::View",
  materialized: "Postgres::MaterializedView",
  sequence: "Postgres::Sequence",
  type: "Postgres::Enum",
  domain: "Postgres::Domain",
  schema: "Postgres::Schema",
  extension: "Postgres::Extension",
};
const obj = (key: string, kind: keyof typeof TYPES, ddl: string): PgSchemaObject => ({ key, canonical: { ...diffObject(TYPES[kind]!, ddl, "public"), exportName: key } });
const diff = (before: PgSchemaObject[], after: PgSchemaObject[]): PgSchemaDiff => diffPgSchemas(before, after);
const rules = (d: PgSchemaDiff) => d.changes.map((c) => [c.field, c.rule, c.class]);

const ORDERS = "CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) NOT NULL, note varchar(20), status text)";
const table = (ddl: string) => obj("orders", "table", ddl);

describe("columns", () => {
  test("adding a column: metadata, a rewrite for a volatile default or stored generated column, expand for NOT NULL with no default", () => {
    const d = diff(
      [table(ORDERS)],
      [
        table(`CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) NOT NULL, note varchar(20), status text,
          a int, b timestamptz NOT NULL DEFAULT now(), c uuid DEFAULT gen_random_uuid(), d numeric GENERATED ALWAYS AS (amount * 2) STORED,
          e numeric GENERATED ALWAYS AS (amount * 3), f bigint GENERATED ALWAYS AS IDENTITY, g int NOT NULL)`),
      ],
    );
    expect(rules(d)).toEqual([
      ["columns.a", "SQLPG201", "metadata"],
      ["columns.b", "SQLPG201", "metadata"],
      ["columns.c", "SQLPG202", "rewrite"],
      ["columns.d", "SQLPG202", "rewrite"],
      ["columns.e", "SQLPG201", "metadata"],
      ["columns.f", "SQLPG202", "rewrite"],
      ["columns.g", "SQLPG203", "expand"],
    ]);
    expect(d.refused.map((c) => c.field)).toEqual(["columns.g"]);
  });

  test("a type change is metadata when binary-coercible, a rewrite within a kind, expand across kinds", () => {
    const d = diff(
      [table(ORDERS)],
      [table("CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(14,2) NOT NULL, note text, status integer)")],
    );
    expect(rules(d)).toEqual([
      ["columns.amount.type", "SQLPG206", "metadata"],
      ["columns.note.type", "SQLPG206", "metadata"],
      ["columns.status.type", "SQLPG208", "expand"],
    ]);
    expect(rules(diff([table("CREATE TABLE app.orders (id integer)")], [table("CREATE TABLE app.orders (id bigint)")]))).toEqual([
      ["columns.id.type", "SQLPG207", "rewrite"],
    ]);
  });

  test("serial is an integer column with an owned sequence: never qualified, classified by the integer types", () => {
    const col = (t: string) => table(`CREATE TABLE app.orders (id ${t} PRIMARY KEY)`);
    const d = diff([col("serial")], [col("bigserial")]);
    expect(rules(d)).toEqual([["columns.id.type", "SQLPG207", "rewrite"]]);
    expect(d.changes[0]!.before).toBe("serial");
    expect(d.changes[0]!.after).toBe("bigserial");
    expect(d.changes[0]!.note).toContain("sequence is widened to bigint");
    expect(rules(diff([col("smallserial")], [col("serial")]))).toEqual([["columns.id.type", "SQLPG207", "rewrite"]]);
    expect(rules(diff([col("serial")], [col("serial")]))).toEqual([]);
    expect(rules(diff([col("serial")], [col("integer")]))).toEqual([["columns.id.default", "SQLPG209", "metadata"]]);
    expect(rules(diff([col("integer")], [col("bigserial")]))).toEqual([["columns.id.type", "SQLPG207", "rewrite"]]);
    expect(rules(diff([col("serial")], [col("text")]))).toEqual([["columns.id.type", "SQLPG208", "expand"]]);
  });

  test("NOT NULL, defaults, comments, and a rename with and without the hint", () => {
    expect(rules(diff([table(ORDERS)], [table("CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) DEFAULT 0, note varchar(20) NOT NULL, status text)")]))).toEqual([
      ["columns.amount.default", "SQLPG209", "metadata"],
      ["columns.amount.notNull", "SQLPG211", "metadata"],
      ["columns.note.notNull", "SQLPG210", "validate"],
    ]);
    const renamed = diff([table(ORDERS)], [table(`CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) NOT NULL, note varchar(20),
      state text -- previously: status
    )`)]);
    expect(rules(renamed)).toEqual([["columns.state", "SQLPG205", "expand"]]);
    const unhinted = diff([table(ORDERS)], [table("CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) NOT NULL, note varchar(20), state text)")]);
    expect(rules(unhinted)).toEqual([
      ["columns.state", "SQLPG201", "metadata"],
      ["columns.status", "SQLPG204", "metadata"],
    ]);
    expect(unhinted.hints[0]).toMatch(/-- previously: status/);
  });

  test("SET NOT NULL proven by a valid check is metadata", () => {
    const before = table("CREATE TABLE app.orders (note text, CONSTRAINT note_nn CHECK (note IS NOT NULL))");
    const after = table("CREATE TABLE app.orders (note text NOT NULL, CONSTRAINT note_nn CHECK (note IS NOT NULL))");
    expect(rules(diff([before], [after]))).toEqual([["columns.note.notNull", "SQLPG210", "metadata"]]);
  });
});

describe("constraints", () => {
  const base = "CREATE TABLE app.orders (id bigint, user_id bigint, amount numeric";
  test("added NOT VALID is metadata; validated, a check is a rewrite and a foreign key a validate; removing NOT VALID validates", () => {
    const before = table(`${base})`);
    const d = diff(
      [before],
      [table(`${base}, CONSTRAINT a CHECK (amount > 0), CONSTRAINT b CHECK (amount < 100) NOT VALID, CONSTRAINT c FOREIGN KEY (user_id) REFERENCES app.users (id), UNIQUE (id), EXCLUDE USING gist (id WITH =))`)],
    );
    expect(rules(d)).toEqual([
      ["constraints.unique", "SQLPG221", "concurrently"],
      ["constraints.a", "SQLPG218", "rewrite"],
      ["constraints.b", "SQLPG217", "metadata"],
      ["constraints.c", "SQLPG219", "validate"],
      ["constraints.exclude", "SQLPG222", "rewrite"],
    ]);
    const validated = diff([table(`${base}, CONSTRAINT b CHECK (amount < 100) NOT VALID)`)], [table(`${base}, CONSTRAINT b CHECK (amount < 100))`)]);
    expect(rules(validated)).toEqual([["constraints.b", "SQLPG220", "validate"]]);
  });

  test("an unnamed constraint matches the server's named one by what it says, and a dropped one is metadata", () => {
    const declared = table(`${base}, CHECK (amount IN (1, 2)))`);
    const live = table(`${base}, CONSTRAINT orders_amount_check CHECK ((amount = ANY (ARRAY[1, 2]))))`);
    expect(diff([live], [declared]).changes).toEqual([]);
    expect(rules(diff([live], [table(`${base})`)]))).toEqual([["constraints.orders_amount_check", "SQLPG223", "metadata"]]);
  });
});

describe("objects", () => {
  test("an index on an existing table needs CONCURRENTLY; on a new table it is part of the create", () => {
    const users = table(ORDERS);
    const conc = obj("byStatus", "index", "CREATE INDEX CONCURRENTLY by_status ON app.orders (status)");
    const plain = obj("byNote", "index", "CREATE INDEX by_note ON app.orders (note)");
    expect(rules(diff([users], [users, conc, plain]))).toEqual([
      ["index", "SQLPG240", "concurrently"],
      ["index", "SQLPG241", "concurrently"],
    ]);
    expect(rules(diff([], [users, plain])).map((r) => r[1])).toEqual(["SQLPG200", "SQLPG200"]);
    expect(rules(diff([users, plain], [users]))).toEqual([["index", "SQLPG242", "concurrently"]]);
    expect(rules(diff([plain], [obj("byNote", "index", "CREATE INDEX by_note ON app.orders (note DESC)")]))).toEqual([["elements", "SQLPG243", "concurrently"]]);
  });

  test("a view that keeps its columns is replaced; one that drops a column is expand; a materialized view is rebuilt", () => {
    const v = (q: string) => obj("v", "view", `CREATE VIEW app.v AS ${q}`);
    expect(rules(diff([v("SELECT id, note FROM app.orders")], [v("SELECT id, note, status FROM app.orders")]))).toEqual([["query", "SQLPG250", "metadata"]]);
    expect(rules(diff([v("SELECT id, note FROM app.orders")], [v("SELECT id FROM app.orders")]))).toEqual([["query", "SQLPG251", "expand"]]);
    const m = (q: string) => obj("m", "materialized", `CREATE MATERIALIZED VIEW app.m AS ${q}`);
    expect(rules(diff([m("SELECT 1 AS a")], [m("SELECT 2 AS a")]))).toEqual([["query", "SQLPG252", "rewrite"]]);
  });

  test("enum labels added are metadata; removed or reordered are expand", () => {
    const e = (labels: string) => obj("s", "type", `CREATE TYPE app.s AS ENUM (${labels})`);
    expect(rules(diff([e("'a', 'c'")], [e("'a', 'b', 'c'")]))).toEqual([["labels", "SQLPG260", "metadata"]]);
    expect(rules(diff([e("'a', 'c'")], [e("'c', 'a'")]))).toEqual([["labels", "SQLPG261", "expand"]]);
  });

  test("renames: an export renamed in SQL is a rename (expand); an index rename is metadata; a dropped table destroys data", () => {
    expect(rules(diff([table(ORDERS)], [table(ORDERS.replace("app.orders", "app.purchases"))]))).toEqual([["name", "SQLPG228", "expand"]]);
    const i = (n: string) => obj("i", "index", `CREATE INDEX ${n} ON app.orders (note)`);
    expect(rules(diff([i("a")], [i("b")]))).toEqual([["name", "SQLPG229", "metadata"]]);
    const dropped = diff([table(ORDERS)], []);
    expect(dropped.changes[0]).toMatchObject({ rule: "SQLPG270", class: "drop", destructive: true });
  });

  test("against a server, -- previously: matches a renamed object by its old qualified name", () => {
    const live = keyedByQualifiedName([table(ORDERS)]);
    const declared = keyedByQualifiedName([table(`-- previously: orders\n${ORDERS.replace("app.orders", "app.purchases")}`)]);
    expect(rules(diffPgSchemas(live, declared))).toEqual([["name", "SQLPG228", "expand"]]);
    expect(renameHints("-- previously: orders\nCREATE TABLE t (\n  a int -- previously: b\n)")).toEqual({ previously: "orders", columns: { a: "b" } });
  });

  test("another tool's table is never proposed for a drop", () => {
    const prisma = { key: "relation public._prisma_migrations", canonical: { ...diffObject("Postgres::Table", "CREATE TABLE public._prisma_migrations (id text)", "public"), foreign: "Prisma Migrate" } };
    const d = diffPgSchemas([prisma], []);
    expect(d.changes).toEqual([]);
    expect(d.hints[0]).toMatch(/kept by Prisma Migrate/);
  });
});

describe("the major (sql.postgresMajor)", () => {
  test("a stored generated expression is a rewrite from 17 and expand before; a table's access method is expand before 15", () => {
    const g = (e: string) => table(`CREATE TABLE app.orders (a int, b int GENERATED ALWAYS AS (${e}) STORED)`);
    expect(diffPgSchemas([g("a * 2")], [g("a * 3")]).changes[0]).toMatchObject({ rule: "SQLPG212", class: "rewrite" });
    expect(diffPgSchemas([g("a * 2")], [g("a * 3")], { major: 16 }).changes[0]).toMatchObject({ rule: "SQLPG212", class: "expand" });
    const am = (m: string) => table(`CREATE TABLE app.orders (a int) USING ${m}`);
    expect(diffPgSchemas([am("heap")], [am("columnar")], { major: 14 }).changes[0]).toMatchObject({ rule: "SQLPG226", class: "expand" });
  });
});

describe("the major a build records (chant sql diff)", () => {
  const build = (expr: string, postgresMajor?: number) => {
    const ddl = `CREATE TABLE app.orders (a int, b int GENERATED ALWAYS AS (${expr}) STORED)`;
    const doc = { dialect: "postgres", ...(postgresMajor === undefined ? {} : { postgresMajor }), applyOrder: ["orders"], objects: [{ export: "orders", type: "Postgres::Table", name: "orders", ddl }] };
    const file = join(mkdtempSync(join(tmpdir(), "pg-major-")), "schema.json");
    writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const cls = (before: string, after: string, config?: number) => diffPgBuildFiles(before, after, config).changes[0]!.class;

  test("the recorded major decides: SET EXPRESSION is a rewrite at 18 and expand and contract at 14", () => {
    expect(cls(build("a * 2", 18), build("a * 3", 18))).toBe("rewrite");
    expect(cls(build("a * 2", 14), build("a * 3", 14))).toBe("expand");
  });
  test("the recorded major wins over the config, and the config answers for a build with none", () => {
    expect(cls(build("a * 2", 18), build("a * 3", 18), 14)).toBe("rewrite");
    expect(cls(build("a * 2", 14), build("a * 3", 14), 18)).toBe("expand");
    expect(cls(build("a * 2"), build("a * 3"), 14)).toBe("expand");
    expect(cls(build("a * 2"), build("a * 3"))).toBe("rewrite");
  });
  test("the newer build's major wins over the older one's", () => {
    expect(cls(build("a * 2", 14), build("a * 3", 18))).toBe("rewrite");
  });
});

describe("the report, disruption and the rule table", () => {
  test("the report names the class, the rule, the lock and the citation, and the refusal", () => {
    const text = renderPgDiff(diff([table(ORDERS)], [table("CREATE TABLE app.orders (id bigint PRIMARY KEY, amount numeric(12,2) NOT NULL, note varchar(20), status integer)")]));
    expect(text).toContain("[EXPAND AND CONTRACT] columns.status.type: text -> integer");
    expect(text).toContain("https://www.postgresql.org/docs/18/sql-altertable.html");
    expect(text).toMatch(/Refused: 1 change/);
  });

  test("classifyDisruption maps paths onto rules, unknown where a path alone cannot say", () => {
    const v = classifyPgDisruption({
      environment: "prod",
      changes: [
        { name: "t", type: "Postgres::Table", deltas: [{ path: "comment" } as never] },
        { name: "u", type: "Postgres::Table", deltas: [{ path: "columns[1].type" } as never] },
        { name: "c", type: "ClickHouse::Table", deltas: [{ path: "comment" } as never] },
      ],
    });
    expect(v.t).toMatchObject({ disruption: "in-place" });
    expect(v.u).toMatchObject({ disruption: "unknown" });
    expect(v.c).toBeUndefined();
  });

  test("every rule cites the Postgres 18 documentation", () => {
    for (const r of Object.values(PG_CLASSIFIER_RULES)) expect(r.cite).toMatch(/^https:\/\/www\.postgresql\.org\/docs\/18\//);
  });
});
