/**
 * The migration-directory readers (#4400): goose, golang-migrate,
 * clickhouse-migrations and Flyway. Each lists a fixture directory's
 * migrations in the order the tool applies them. The trees are in memory:
 * a reader parses files and never runs the tool.
 */

import { describe, expect, test } from "vitest";
import type { KindReaderInput } from "./kind-link-readers";
import { LINK_READERS } from "./kind-link-readers";
import { migrationDigest, REPLAY_FILE, replayFiles } from "./migration-dirs";
import { withReaderOutputs } from "./links";
import { classifyFlywayFile, compareVersions } from "./flyway-dir";
import { parseToml, readFlywayConfig, substitute, FlywayPlaceholderError } from "./flyway-layout";
import { builtinKindRegistry } from "./kinds";
import type { WorkspaceTree } from "./tree";

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
        const [head] = rest.split("/");
        seen.set(head!, rest.includes("/") ? "dir" : "file");
      }
      return [...seen].map(([name, type]) => ({ name, type }));
    },
    read(p) {
      if (!(p in files)) throw new Error(`no such file ${p}`);
      return files[p]!;
    },
  };
}

const run = (reader: keyof typeof LINK_READERS, files: Record<string, string>, fields: Record<string, string> = {}, dir = "") =>
  LINK_READERS[reader]({ member: { name: "m" } as never, dir, fields: fields as KindReaderInput["fields"], tree: memoryTree(files) });
/** The gaps about the files, without the one that asks for a first replay. */
const gapsOf = (r: ReturnType<typeof run>) => r.gaps.filter((g) => !g.message.startsWith(`no ${REPLAY_FILE}`));
const summary = (r: ReturnType<typeof run>) => (r.migrations ?? []).map((m) => `${String(m.position)} ${m.version} ${m.name} ${m.type}`);

describe("the readers are registered", () => {
  test("each kind of the sql lexicon names a reader chant has", () => {
    const names = Object.keys(LINK_READERS);
    expect(names).toEqual(expect.arrayContaining(["goose-dir", "golang-migrate-dir", "clickhouse-migrations-dir", "flyway-dir"]));
    expect(builtinKindRegistry().get("goose")).toBeUndefined();
  });
});

describe("goose", () => {
  const up = (extra = "") => `-- +goose Up\n${extra}CREATE TABLE t (id int);\n`;
  test("lists .sql files by version number, sequential and timestamp alike, with their dialect", () => {
    const r = run("goose-dir", {
      "00010_ten.sql": up(),
      "00002_two.sql": `${up()}-- +goose Down\nDROP TABLE t;\n`,
      "20240101120000_stamp.sql": up(),
      "README.md": "x",
    }, { dialect: "clickhouse" });
    expect(summary(r)).toEqual(["1 2 two versioned", "2 10 ten versioned", "3 20240101120000 stamp versioned"]);
    expect(r.migrations!.map((m) => m.down)).toEqual([true, false, false]);
    expect(r.migrations!.every((m) => m.dialect === "clickhouse")).toBe(true);
    expect(r.migrations![0]).toMatchObject({ file: "00002_two.sql", line: 1 });
    expect(gapsOf(r)).toEqual([]);
  });

  test("annotations are case-insensitive and NO TRANSACTION is read", () => {
    const r = run("goose-dir", { "1_a.sql": "-- +goose NO TRANSACTION\n-- +goose up\nselect 1;\n" });
    expect(r.migrations![0]).toMatchObject({ transaction: false, line: 2 });
  });

  test("a file without Up, a Go migration, a bad name and a duplicate version are gaps", () => {
    const r = run("goose-dir", { "1_a.sql": "select 1;\n", "2_b.go": "package m\n", "x_c.sql": up(), "3_d.sql": up(), "03_e.sql": up() });
    expect(gapsOf(r).map((g) => `${g.file}: ${g.message.split(",")[0]}`)).toEqual([
      "1_a.sql: 1_a.sql has no -- +goose Up annotation",
      "2_b.go: 2_b.go is a Go migration; its code is not SQL",
      "x_c.sql: x_c.sql has no version goose can read: the name starts with a positive integer",
      "3_d.sql: version 3 is also 03_e.sql; goose refuses a duplicate version",
    ]);
    expect(summary(r)).toEqual(["1 3 e versioned", "2 3 d versioned"]);
  });

  test("migrationsDir names the directory under the member's", () => {
    const r = run("goose-dir", { "db/migrations/1_a.sql": up() }, { migrationsDir: "migrations" }, "db");
    expect(r.migrations![0]!.file).toBe("db/migrations/1_a.sql");
  });
});

describe("golang-migrate", () => {
  test("lists the up files by numeric version, and pairs each with its down file", () => {
    const r = run("golang-migrate-dir", {
      "10_ten.up.sql": "select 1;\n",
      "2_two.up.sql": "select 1;\n",
      "2_two.down.sql": "select 1;\n",
      "1700000000_stamp.up.sql": "select 1;\n",
      "notes.txt": "",
    });
    expect(summary(r)).toEqual(["1 2 two versioned", "2 10 ten versioned", "3 1700000000 stamp versioned"]);
    expect(r.migrations!.map((m) => m.down)).toEqual(["2_two.down.sql", false, false]);
    expect(gapsOf(r)).toEqual([]);
  });

  test("a down file with no up file, and a duplicate version, are gaps", () => {
    const r = run("golang-migrate-dir", { "1_a.up.sql": "", "01_b.up.sql": "", "5_c.down.sql": "" });
    expect(gapsOf(r).map((g) => g.message)).toEqual([
      "1_a.up.sql: another up file already has version 1; golang-migrate refuses a duplicate",
      "version 5 has a down file and no up file",
    ]);
  });
});

describe("clickhouse-migrations", () => {
  test("lists <version>_<name>.sql in numeric order, with the Python tool's .down.sql rollbacks", () => {
    const r = run("clickhouse-migrations-dir", { "10_b.sql": "", "002_a.sql": "", "002_a.down.sql": "", "README.md": "" });
    expect(summary(r)).toEqual(["1 002 a versioned", "2 10 b versioned"]);
    expect(r.migrations!.map((m) => m.down)).toEqual(["002_a.down.sql", false]);
    expect(r.migrations!.every((m) => m.dialect === "clickhouse")).toBe(true);
  });

  test("a name with no version and a version written twice are gaps", () => {
    const r = run("clickhouse-migrations-dir", { "init.sql": "", "1_a.sql": "", "001_b.sql": "" });
    expect(gapsOf(r).map((g) => g.message.split(",")[0])).toEqual([
      "init.sql has no version before its first _",
      "version 1 is also 001_b.sql; leading zeros are not significant",
    ]);
  });
});

describe("flyway", () => {
  test("orders versions as numbers, then repeatable migrations by description, and skips callbacks", () => {
    const r = run("flyway-dir", {
      "V10__ten.sql": "",
      "V2__two.sql": "",
      "V1_1__one_one.sql": "",
      "R__views.sql": "",
      "R__a_first.sql": "",
      "beforeMigrate.sql": "",
      "U2__undo_two.sql": "",
      "schema.sql": "",
    });
    expect(summary(r)).toEqual(["1 1.1 one one versioned", "2 2 two versioned", "3 10 ten versioned", "4  a first repeatable", "5  views repeatable"]);
    expect(r.migrations![1]!.down).toBe("U2__undo_two.sql");
    expect(gapsOf(r)).toEqual([]);
  });

  test("locations come from flyway.toml, read recursively", () => {
    const r = run("flyway-dir", {
      "flyway.toml": '[flyway]\nlocations = ["filesystem:sql", "classpath:db/migration"]\n\n[environments.default]\nurl = "jdbc:clickhouse://localhost:8123/shop"\n',
      "sql/V1__a.sql": "",
      "sql/more/V2__b.sql": "",
      "src/main/resources/db/migration/V3__c.sql": "",
      "elsewhere/V9__x.sql": "",
    });
    expect(summary(r)).toEqual(["1 1 a versioned", "2 2 b versioned", "3 3 c versioned"]);
    expect(r.migrations![0]!.dialect).toBe("clickhouse");
  });

  test("flyway.conf locations, a configuration above the member, and the dialect field", () => {
    const r = run("flyway-dir", { "flyway.conf": "flyway.locations=filesystem:db/sql\nflyway.url=jdbc:postgresql://h/d\n", "db/sql/V1__a.sql": "" }, { dialect: "clickhouse" }, "db");
    // The configuration sits above the member, so db/sql is relative to the root.
    expect(r.migrations!.map((m) => `${m.file} ${m.dialect}`)).toEqual(["db/sql/V1__a.sql clickhouse"]);
  });

  test("without a configuration the member's directory is the location", () => {
    expect(summary(run("flyway-dir", { "db/V1__a.sql": "" }, {}, "db"))).toEqual(["1 1 a versioned"]);
  });

  test("a code migration, a duplicate version and an outside location are gaps", () => {
    const r = run("flyway-dir", {
      "flyway.toml": '[flyway]\nlocations = ["filesystem:sql", "filesystem:../shared"]\n',
      "sql/V1__a.sql": "",
      "sql/V1_0__b.sql": "",
      "sql/V2__Code.java": "",
    });
    expect(gapsOf(r).map((g) => g.message.split(",")[0])).toEqual([
      "the location filesystem:../shared lies outside the workspace",
      "V2__Code.java is a code migration; its code is not SQL",
      "version 1 is also sql/V1_0__b.sql; Flyway refuses two migrations with one version",
    ]);
  });
});

describe("the shared Flyway layout", () => {
  test("version comparison is numeric, part by part", () => {
    expect(["10", "2", "1.10", "1.2", "1"].sort(compareVersions)).toEqual(["1", "1.2", "1.10", "2", "10"]);
  });

  test("file names follow the configured prefixes, separator and suffixes", () => {
    const config = readFlywayConfig(memoryTree({ "flyway.conf": "flyway.sqlMigrationPrefix=M\nflyway.sqlMigrationSeparator=--\nflyway.sqlMigrationSuffixes=.ddl\n" }), "flyway.conf", "");
    expect(classifyFlywayFile("M3--add.ddl", config)).toMatchObject({ type: "versioned", version: "3", description: "add" });
    expect(classifyFlywayFile("V3__add.sql", config)).toBeUndefined();
  });

  test("toml tables, arrays and comments parse", () => {
    expect(parseToml('# c\n[flyway]\nlocations = [\n "a", # x\n "b"\n]\nvalidateOnMigrate = true\n').flyway).toEqual({ locations: ["a", "b"], validateOnMigrate: true });
  });

  test("placeholders substitute, and a missing one names its file and line", () => {
    const config = readFlywayConfig(memoryTree({ "flyway.conf": "flyway.placeholders.env=prod\nflyway.table=hist\n" }), "flyway.conf", "");
    expect(substitute("a ${env}\nb ${flyway:table}", "V1__a.sql", config)).toBe("a prod\nb hist");
    expect(() => substitute("ok\n${nope}", "V1__a.sql", config)).toThrow(FlywayPlaceholderError);
    expect(() => substitute("ok\n${nope}", "V1__a.sql", config)).toThrow(/V1__a\.sql:2: no value for the placeholder \$\{nope\}/);
  });
});

describe("the recorded replay", () => {
  const goose = { "1_a.sql": "-- +goose Up\nCREATE TABLE a (id int);\n", "2_b.sql": "-- +goose Up\nALTER TABLE a ADD c int;\n" };
  const snapshot = (files: Record<string, string>, outputs: string[]) => {
    const tree = memoryTree(files);
    const r = run("goose-dir", files);
    const digest = migrationDigest((f) => tree.read(f), replayFiles(tree, r.migrations!));
    return JSON.stringify({ schema: 1, dialect: "postgres", digest, outputs }, null, 2);
  };

  test("without a snapshot the outputs are a gap that says to replay", () => {
    const r = run("goose-dir", goose);
    expect(r.outputs).toBeUndefined();
    expect(r.gaps).toEqual([expect.objectContaining({ outputs: true, message: expect.stringContaining("chant sql replay") })]);
  });

  test("a snapshot whose digest matches gives its names as outputs, with the line that states each", () => {
    const r = run("goose-dir", { ...goose, [REPLAY_FILE]: snapshot(goose, ["public.a", "public.a.id", "public.a.c"]) });
    expect(r.gaps).toEqual([]);
    expect(r.outputs).toEqual([
      { name: "public.a", file: REPLAY_FILE, line: 5 },
      { name: "public.a.id", file: REPLAY_FILE, line: 6 },
      { name: "public.a.c", file: REPLAY_FILE, line: 7 },
    ]);
  });

  test("an edited migration makes the snapshot stale: no outputs and a gap", () => {
    const stale = { ...goose, "2_b.sql": "-- +goose Up\nALTER TABLE a DROP COLUMN id;\n" };
    const r = run("goose-dir", { ...stale, [REPLAY_FILE]: snapshot(goose, ["public.a"]) });
    expect(r.outputs).toBeUndefined();
    expect(r.gaps[0]).toMatchObject({ file: REPLAY_FILE, outputs: true, message: expect.stringContaining("changed since") });
  });

  test("a new migration makes it stale too, and a snapshot that is not one is a gap", () => {
    expect(run("goose-dir", { ...goose, "3_c.sql": "-- +goose Up\nselect 1;\n", [REPLAY_FILE]: snapshot(goose, []) }).gaps[0]!.message).toContain("changed since");
    expect(run("goose-dir", { ...goose, [REPLAY_FILE]: "{}" }).gaps[0]!.message).toContain("not a replay snapshot");
    expect(run("goose-dir", { ...goose, [REPLAY_FILE]: "{" }).gaps[0]!.message).toContain("could not be read");
  });

  test("a Flyway snapshot also depends on the configuration, which holds the placeholders", () => {
    const files = { "flyway.conf": "flyway.placeholders.t=a\n", "V1__a.sql": "create table ${t} (id int);\n" };
    const tree = memoryTree(files);
    const r = run("flyway-dir", files);
    const digest = migrationDigest((f) => tree.read(f), replayFiles(tree, r.migrations!, ["flyway.conf"]));
    const snap = JSON.stringify({ schema: 1, dialect: "postgres", digest, outputs: ["public.a"] });
    expect(run("flyway-dir", { ...files, [REPLAY_FILE]: snap }).outputs!.map((o) => o.name)).toEqual(["public.a"]);
    expect(run("flyway-dir", { ...files, "flyway.conf": "flyway.placeholders.t=b\n", [REPLAY_FILE]: snap }).outputs).toBeUndefined();
  });

  test("the outputs reach a consumer's link through withReaderOutputs: a column the migrations drop is missing", () => {
    const base = new Map([["db", { outputs: [], complete: true, why: null, exposesNone: false }]]) as never;
    const read = run("goose-dir", { ...goose, [REPLAY_FILE]: snapshot(goose, ["public.a", "public.a.id"]) });
    const handles = withReaderOutputs(base, new Map([["db", read]]));
    expect(handles.get("db")!.outputs.map((o) => o.name)).toEqual(["public.a", "public.a.id"]);
    expect(handles.get("db")!.complete).toBe(true);
    const unreplayed = withReaderOutputs(base, new Map([["db", run("goose-dir", goose)]]));
    expect(unreplayed.get("db")!.complete).toBe(false);
  });
});
