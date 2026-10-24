/**
 * Classifying the migration files a pull request adds (#4407), for goose,
 * golang-migrate, clickhouse-migrations and Flyway. Each fixture directory is
 * an in-memory tree at the base commit and another at the head, with one
 * file added; the answer is what the plan note lists. Offline: nothing here
 * opens a server.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { LINK_READERS, type KindLinkRead } from "@intentius/chant/workspace/kind-link-readers";
import { classifyNewMigrations, newMigrationGroups } from "@intentius/chant/workspace/new-migrations";
import { renderMigrationLines } from "@intentius/chant/pr-migrations";
import type { WorkspaceTree } from "@intentius/chant/workspace/tree";
import { classifyMigrationFiles } from "./migration-classify";

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

const sql = { name: "sql", classifyMigrations: classifyMigrationFiles };

/** The files the pull request adds, classified, as the plan note lists them. */
async function classify(reader: keyof typeof LINK_READERS, fields: Record<string, string>, base: Record<string, string>, added: Record<string, string>) {
  const head = memoryTree({ ...base, ...added });
  const read = new Map<string, KindLinkRead>([["m", LINK_READERS[reader]({ member: { name: "m" } as never, dir: "db", fields: fields as never, tree: head })]]);
  const groups = newMigrationGroups([{ name: "m", dir: "db" }], read, memoryTree(base));
  return classifyNewMigrations(groups, head, [sql]);
}

const rules = (f: Awaited<ReturnType<typeof classify>>[number]) => f.statements.flatMap((s) => s.changes.map((c) => c.rule));

describe("a new file in each migration directory kind appears with classes", () => {
  test("goose: the Up section only", async () => {
    const [f, ...rest] = await classify(
      "goose-dir",
      { dialect: "postgres" },
      { "db/00001_init.sql": "-- +goose Up\nCREATE TABLE orders (id bigint PRIMARY KEY, status text);\n-- +goose Down\nDROP TABLE orders;\n" },
      {
        "db/00002_idx.sql":
          "-- +goose Up\nCREATE INDEX orders_status_idx ON orders (status);\nALTER TABLE orders ADD COLUMN note text;\n-- +goose Down\nDROP INDEX orders_status_idx;\n",
      },
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ member: "m", reader: "goose-dir", file: "db/00002_idx.sql", dialect: "postgres" });
    expect(rules(f!)).toEqual(["SQLPG241", "SQLPG201"]);
    expect(f!.statements[0]!.changes[0]).toMatchObject({ class: "concurrently", lock: "SHARE" });
  });

  test("golang-migrate: the .up file, not the .down file", async () => {
    const out = await classify(
      "golang-migrate-dir",
      { dialect: "postgres" },
      { "db/000001_init.up.sql": "CREATE TABLE t (id bigint);", "db/000001_init.down.sql": "DROP TABLE t;" },
      { "db/000002_fk.up.sql": "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES u (id) NOT VALID;", "db/000002_fk.down.sql": "ALTER TABLE t DROP CONSTRAINT fk;" },
    );
    expect(out.map((f) => f.file)).toEqual(["db/000002_fk.up.sql"]);
    expect(rules(out[0]!)).toEqual(["SQLPG217"]);
  });

  test("clickhouse-migrations: a sort-key change is a rebuild", async () => {
    const [f] = await classify(
      "clickhouse-migrations-dir",
      {},
      { "db/1_events.sql": "CREATE TABLE events (user_id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY ts;" },
      { "db/2_key.sql": "ALTER TABLE events MODIFY ORDER BY (user_id, ts);" },
    );
    expect(f).toMatchObject({ dialect: "clickhouse" });
    expect(f!.statements[0]).toMatchObject({ outcome: "classified", changes: [{ rule: "SQLCH220", class: "rebuild", label: "REBUILD" }] });
  });

  test("flyway: placeholders are substituted before the statements are read", async () => {
    const [f] = await classify(
      "flyway-dir",
      { dialect: "postgres" },
      { "db/V1__init.sql": "CREATE TABLE ${schema}.t (id bigint);", "db/flyway.conf": "flyway.locations=filesystem:.\nflyway.placeholders.schema=app\n" },
      { "db/V2__idx.sql": "CREATE INDEX CONCURRENTLY i ON ${schema}.t (id);" },
    );
    expect(f).toMatchObject({ file: "db/V2__idx.sql", type: "versioned" });
    expect(f!.statements[0]!.sql).toBe("CREATE INDEX CONCURRENTLY i ON app.t (id)");
    expect(rules(f!)).toEqual(["SQLPG240"]);
  });

  test("flyway: a placeholder with no value is reported on the file, not thrown", async () => {
    const [f] = await classify("flyway-dir", { dialect: "postgres" }, { "db/V1__init.sql": "SELECT 1;" }, { "db/V2__x.sql": "CREATE TABLE ${missing}.t (id bigint);" });
    expect(f!.statements).toEqual([]);
    expect(f!.error).toContain("missing");
  });
});

describe("the plan note lines", () => {
  test("a Postgres CREATE INDEX without CONCURRENTLY is listed with its lock", async () => {
    const files = await classify("goose-dir", { dialect: "postgres" }, { "db/1_a.sql": "-- +goose Up\nSELECT 1;\n" }, { "db/2_b.sql": "-- +goose Up\nCREATE INDEX i ON orders (status);\n" });
    const lines = renderMigrationLines(files).join("\n");
    expect(lines).toContain("`db/2_b.sql` (member `m`, postgres)");
    expect(lines).toContain("`CREATE INDEX i ON orders (status)`: needs CONCURRENTLY (SQLPG241, SHARE)");
  });

  test("a ClickHouse sort-key change is listed as a rebuild", async () => {
    const files = await classify("clickhouse-migrations-dir", {}, { "db/1_a.sql": "SELECT 1;" }, { "db/2_b.sql": "ALTER TABLE events MODIFY ORDER BY (a, b);" });
    expect(renderMigrationLines(files).join("\n")).toContain("REBUILD (SQLCH220)");
  });

  test("an undecided statement names both rules", async () => {
    const files = await classify("clickhouse-migrations-dir", {}, { "db/1_a.sql": "SELECT 1;" }, { "db/2_b.sql": "ALTER TABLE events MODIFY COLUMN user_id UInt32;" });
    expect(renderMigrationLines(files).join("\n")).toContain("undecided between SQLCH210 background rewrite and SQLCH211 REBUILD");
  });
});

describe("offline", () => {
  test("classifying contacts no server and starts no process", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
    await classify("goose-dir", { dialect: "postgres" }, { "db/1_a.sql": "-- +goose Up\nSELECT 1;\n" }, { "db/2_b.sql": "-- +goose Up\nDROP TABLE t;\n" });
    await classify("clickhouse-migrations-dir", {}, { "db/1_a.sql": "SELECT 1;" }, { "db/2_b.sql": "DROP TABLE t;" });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  test("the classifier modules import no live binding, client or process API", () => {
    for (const f of ["migration-classify.ts", "postgres/plan/statements.ts", "clickhouse/plan/statements.ts", "core/statement-class.ts"]) {
      const src = readFileSync(join(import.meta.dirname, f), "utf8");
      const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) expect(spec, `${f} imports ${spec}`).not.toMatch(/\/live\/|\/apply\/|\/http$|child_process|node:net|node:http|node:https|\/bind$/);
    }
  });
});
