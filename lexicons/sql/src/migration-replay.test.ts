/**
 * Replaying a migration directory (#4400), against a fake server: the
 * statements it sends, the catalog names it records, and the round trip into
 * the kind reader's outputs. The emulator runs in `migration-replay.e2e.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { LINK_READERS } from "@intentius/chant/workspace/kind-link-readers";
import { REPLAY_FILE } from "@intentius/chant/workspace/migration-dirs";
import type { WorkspaceTree } from "@intentius/chant/workspace/tree";
import { applySteps, gooseUpStatements, readCatalogOutputs, renderSnapshot, replayDirectory, replaySteps, splitStatements, type ReplayDb } from "./migration-replay";

function memoryTree(files: Record<string, string>): WorkspaceTree {
  const dirs = new Set([""]);
  for (const f of Object.keys(files)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    label: "",
    stat: (p) => (p in files ? "file" : dirs.has(p) ? "dir" : undefined),
    list(p) {
      if (!dirs.has(p)) return undefined;
      const prefix = p === "" ? "" : `${p}/`;
      const seen = new Map<string, "file" | "dir">();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        seen.set(rest.split("/")[0]!, rest.includes("/") ? "dir" : "file");
      }
      return [...seen].map(([name, type]) => ({ name, type }));
    },
    read(p) {
      if (!(p in files)) throw new Error(`no such file ${p}`);
      return files[p]!;
    },
  };
}

/** A server that records what it is sent and answers the catalog query with `catalog`. */
function fakeDb(dialect: "postgres" | "clickhouse", catalog: () => Record<string, unknown>[], failOn?: RegExp): ReplayDb & { sent: string[] } {
  const sent: string[] = [];
  return {
    dialect,
    sent,
    async run(sql) {
      if (failOn?.test(sql)) throw new Error("relation does not exist");
      sent.push(sql);
    },
    rows: async () => catalog(),
    close: async () => {},
  };
}

describe("splitting statements", () => {
  test("semicolons inside strings, identifiers, comments and dollar quotes do not end a statement", () => {
    const sql = `create table a (x text default 'a;b');\n-- c; d\ncreate function f() returns int as $$ begin return 1; end $$ language plpgsql;\n/* x; */ select "a;b" from a;\n;;`;
    expect(splitStatements(sql)).toEqual([
      "create table a (x text default 'a;b')",
      "-- c; d\ncreate function f() returns int as $$ begin return 1; end $$ language plpgsql",
      '/* x; */ select "a;b" from a',
    ]);
  });

  test("a final statement without a semicolon is kept, and a comment alone is dropped", () => {
    expect(splitStatements("select 1;\n-- done\n")).toEqual(["select 1"]);
    expect(splitStatements("select 1;\nselect 2")).toEqual(["select 1", "select 2"]);
  });
});

describe("goose Up statements", () => {
  test("only the Up section runs, and StatementBegin to StatementEnd is one statement", () => {
    const text = [
      "-- +goose Up",
      "create table a (id int);",
      "-- +goose StatementBegin",
      "create function f() returns int as $$ begin return 1; end; $$ language plpgsql;",
      "select 1;",
      "-- +goose StatementEnd",
      "alter table a add c int;",
      "-- +goose Down",
      "drop table a;",
    ].join("\n");
    expect(gooseUpStatements(text)).toEqual(["create table a (id int)", "create function f() returns int as $$ begin return 1; end; $$ language plpgsql;\nselect 1;", "alter table a add c int"]);
  });
});

describe("the steps per kind", () => {
  test("golang-migrate runs the up files in version order, never the down files", () => {
    const { steps } = replaySteps("golang-migrate", memoryTree({ "10_b.up.sql": "create table b (id int);", "2_a.up.sql": "create table a (id int);", "2_a.down.sql": "drop table a;" }), "");
    expect(steps.map((s) => [s.migration.file, s.statements])).toEqual([["2_a.up.sql", ["create table a (id int)"]], ["10_b.up.sql", ["create table b (id int)"]]]);
  });

  test("Flyway substitutes placeholders, runs versioned then repeatable, and skips undo and callbacks", () => {
    const { steps } = replaySteps(
      "flyway",
      memoryTree({
        "flyway.conf": "flyway.placeholders.t=orders\n",
        "V1__a.sql": "create table ${t} (id int);",
        "R__v.sql": "create or replace view v as select 1;",
        "U1__a.sql": "drop table orders;",
        "beforeMigrate.sql": "select 1;",
      }),
      "",
    );
    expect(steps.map((s) => s.statements)).toEqual([["create table orders (id int)"], ["create or replace view v as select 1"]]);
  });

  test("a Flyway placeholder with no value fails naming the file and line", () => {
    expect(() => replaySteps("flyway", memoryTree({ "V1__a.sql": "select 1;\ncreate table ${nope} (id int);" }), "")).toThrow(/V1__a\.sql:2: no value for the placeholder \$\{nope\}/);
  });
});

describe("replaying", () => {
  test("a failing statement names the migration file", async () => {
    const { steps } = replaySteps("golang-migrate", memoryTree({ "1_a.up.sql": "create table a (id int);", "2_b.up.sql": "alter table missing add c int;" }), "");
    await expect(applySteps(fakeDb("postgres", () => [], /missing/), steps)).rejects.toThrow(/2_b\.up\.sql: statement 1 failed: relation does not exist/);
  });

  test("the catalog rows become <schema>.<table> and <schema>.<table>.<column>", async () => {
    const db = fakeDb("clickhouse", () => [
      { schema: "app", relation: "events", col: "ts" },
      { schema: "app", relation: "events", col: "kind" },
      { schema: "app", relation: "empty", col: null },
    ]);
    expect(await readCatalogOutputs(db)).toEqual(["app.events", "app.events.ts", "app.events.kind", "app.empty"]);
  });

  test("a server that already has tables is refused", async () => {
    await expect(replayDirectory(fakeDb("postgres", () => [{ schema: "public", relation: "old", col: "id" }]), "goose", memoryTree({}), "")).rejects.toThrow(/already has public\.old/);
  });

  test("a dialect mismatch is refused before anything runs", async () => {
    const db = fakeDb("clickhouse", () => []);
    await expect(replayDirectory(db, "goose", memoryTree({ "1_a.sql": "-- +goose Up\nselect 1;" }), "")).rejects.toThrow(/migrations are postgres and the server is clickhouse/);
    expect(db.sent).toEqual([]);
  });

  test("the snapshot a replay writes is what the kind reader reads back as outputs, until a migration changes", async () => {
    const files: Record<string, string> = {
      "1_users.sql": "-- +goose Up\ncreate table users (id int, email text);\n-- +goose Down\ndrop table users;\n",
      "2_orders.sql": "-- +goose Up\ncreate table orders (id int, user_id int);\n",
    };
    let created = false;
    const db = fakeDb("postgres", () =>
      created
        ? [
            { schema: "public", relation: "users", col: "id" },
            { schema: "public", relation: "users", col: "email" },
            { schema: "public", relation: "orders", col: "id" },
            { schema: "public", relation: "orders", col: "user_id" },
          ]
        : [],
    );
    const original = db.run;
    db.run = async (sql) => {
      await original(sql);
      created = true;
    };
    const snapshot = await replayDirectory(db, "goose", memoryTree(files), "");
    expect(db.sent).toEqual(["create table users (id int, email text)", "create table orders (id int, user_id int)"]);
    expect(snapshot.outputs).toEqual(["public.users", "public.users.id", "public.users.email", "public.orders", "public.orders.id", "public.orders.user_id"]);

    const withSnapshot = { ...files, [REPLAY_FILE]: renderSnapshot(snapshot) };
    const read = (f: Record<string, string>) => LINK_READERS["goose-dir"]({ member: { name: "db" } as never, dir: "", fields: null, tree: memoryTree(f) });
    expect(read(withSnapshot).outputs!.map((o) => o.name)).toEqual(snapshot.outputs);
    expect(read(withSnapshot).gaps).toEqual([]);

    const dropped = read({ ...withSnapshot, "3_drop.sql": "-- +goose Up\nalter table orders drop column user_id;\n" });
    expect(dropped.outputs).toBeUndefined();
    expect(dropped.gaps[0]).toMatchObject({ outputs: true, message: expect.stringContaining("changed since") });
  });
});
