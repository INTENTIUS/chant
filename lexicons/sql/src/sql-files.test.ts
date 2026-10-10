import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@intentius/chant/build";
import { readSqlFile, sqlFileDeclarations, SqlFileError } from "./sql-files";
import { sqlPlugin } from "./plugin";
import { sqlSerializer } from "./serializer";
import { guessDialect, SqlFileParser } from "./import-parser";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PG_DDL = `BEGIN;
CREATE TYPE app.status AS ENUM ('placed', 'paid');
CREATE TABLE app.orders (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL,
  status app.status NOT NULL
);
CREATE TABLE app.users (id bigint PRIMARY KEY, email text NOT NULL);
ALTER TABLE app.orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES app.users (id);
CREATE INDEX orders_user_idx ON app.orders (user_id);
COMMENT ON TABLE app.users IS 'People';
COMMENT ON COLUMN app.users.email IS 'Login';
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
COMMIT;
`;

describe("reading a file of Postgres DDL", () => {
  test("each CREATE is an object, with its comments, row security and added constraints folded in", () => {
    const objects = readSqlFile("postgres", PG_DDL, { origin: "schema.sql" });
    expect(objects.map((o) => [o.export, o.type, o.name])).toEqual([
      ["status", "Postgres::Enum", "app.status"],
      ["orders", "Postgres::Table", "app.orders"],
      ["users", "Postgres::Table", "app.users"],
      ["ordersUserIdx", "Postgres::Index", "app.orders_user_idx"],
    ]);
    expect(objects[1]!.ddl).toContain("CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES app.users (id)\n)");
    expect(objects[2]!.ddl).toBe(
      "CREATE TABLE app.users (id bigint PRIMARY KEY, email text NOT NULL);\nCOMMENT ON TABLE app.users IS 'People';\nCOMMENT ON COLUMN app.users.email IS 'Login';\nALTER TABLE app.users ENABLE ROW LEVEL SECURITY",
    );
  });

  test("a statement that declares nothing or does not parse is an error naming it, and every one is named", () => {
    const read = () => readSqlFile("postgres", "CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\nCREATE TABLE b (id int,);\nCOMMENT ON TABLE c IS 'x';", { origin: "db/schema.sql" });
    expect(read).toThrow(SqlFileError);
    expect(read).toThrow(/^db\/schema\.sql: 3 statements chant cannot read as declarations/);
    expect(read).toThrow(/not a statement that declares an object: INSERT INTO a VALUES \(1\)/);
    expect(read).toThrow(/does not parse \(.*\): CREATE TABLE b \(id int,\)/);
    expect(read).toThrow(/COMMENT ON TABLE for an object the file does not create: COMMENT ON TABLE c IS 'x'/);
  });

  test("schema qualifies the names the DDL leaves unqualified", () => {
    const { content } = sqlFileDeclarations("postgres", "CREATE TYPE s AS ENUM ('a');\nCREATE TABLE u (id int PRIMARY KEY, k s);\nCREATE TABLE o (u int REFERENCES u (id));", { origin: "x", schema: "app" });
    expect(content).toContain("CREATE TABLE app.u (id int PRIMARY KEY, k ${s})");
    expect(content).toContain("CREATE TABLE app.o (u int REFERENCES ${u} (id))");
  });
});

describe("chant import of a .sql file", () => {
  test("the dialect is read off the statements, and Postgres DDL imports as Postgres declarations", () => {
    expect(guessDialect(PG_DDL)).toBe("postgres");
    expect(guessDialect("CREATE TABLE a.t (x UInt8) ENGINE = Log")).toBe("clickhouse");
    expect(guessDialect("CREATE VIEW a.v AS SELECT 1")).toBe("clickhouse");
    expect(guessDialect("CREATE FUNCTION f AS (x) -> x + 1")).toBe("clickhouse");
    expect(guessDialect("CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$")).toBe("postgres");
    expect(new SqlFileParser().parse(PG_DDL).resources.map((r) => r.type)).toEqual(["Postgres::Enum", "Postgres::Table", "Postgres::Table", "Postgres::Index"]);
  });

  test("a statement it cannot read stops the import, named", () => {
    expect(() => new SqlFileParser("clickhouse").parse("CREATE DATABASE a;\nINSERT INTO a.t VALUES (1)")).toThrow(/not a CREATE statement: INSERT INTO a\.t VALUES \(1\)/);
  });
});

/** A project directory under the repository, so its imports resolve. */
async function project(name: string, files: Record<string, string>): Promise<string> {
  const path = join(repoRoot, ".cache", `sql-3646-${name}-${process.pid}`);
  await rm(path, { recursive: true, force: true });
  await mkdir(join(path, "src"), { recursive: true });
  const dir = await realpath(path);
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, "src", file), content);
  return dir;
}

/** A build document with each DDL's whitespace runs collapsed. */
const squeeze = (doc: unknown): unknown => JSON.parse(JSON.stringify(doc, (k, v: unknown) => (k === "ddl" && typeof v === "string" ? v.replace(/\s+/g, " ") : v)));

async function buildProject(dir: string, config: Record<string, unknown> = {}) {
  const result = await build(join(dir, "src"), [sqlSerializer], undefined, {
    lexicons: ["sql"],
    intrinsics: sqlPlugin.intrinsics?.() ?? [],
    buildRoots: [(ctx) => sqlPlugin.buildRoots!({ projectRoot: dir, config, entities: ctx.entities, ...(ctx.sourceDir ? { sourceDir: ctx.sourceDir } : {}) })],
  });
  const out = result.outputs.get("sql");
  const primary = typeof out === "string" ? out : out?.primary;
  return { errors: result.errors.map((e) => e.message), doc: primary ? (JSON.parse(primary) as { applyOrder: string[]; objects: Array<Record<string, unknown>> }) : undefined };
}

const CH_DDL = `CREATE DATABASE analytics;
CREATE TABLE analytics.events (ts DateTime, kind String) ENGINE = MergeTree ORDER BY ts;
CREATE TABLE analytics.counts (kind String, n UInt64) ENGINE = SummingMergeTree ORDER BY kind;
CREATE MATERIALIZED VIEW analytics.counts_mv TO analytics.counts AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind;
CREATE DICTIONARY analytics.kinds (kind String, label String DEFAULT '') PRIMARY KEY kind SOURCE(clickhouse(table 'counts' db 'analytics')) LAYOUT(complex_key_hashed()) LIFETIME(300);
CREATE FUNCTION kind_label AS (k) -> upper(k);
`;

describe("chant build reads the .sql files in the source directory", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  for (const [dialect, ddl] of [
    ["postgres", PG_DDL.replace("CREATE TYPE", "CREATE SCHEMA app;\nCREATE TYPE")],
    ["clickhouse", CH_DDL],
  ] as const) {
    test(`${dialect}: the same build as the declarations chant import writes for the file`, async () => {
      const fromSql = await project(`${dialect}-sql`, { "schema.sql": ddl });
      const fromTs = await project(`${dialect}-ts`, { "schema.ts": sqlFileDeclarations(dialect, ddl, { origin: "schema.sql" }).content });
      dirs.push(fromSql, fromTs);
      const a = await buildProject(fromSql, { sql: { dialect } });
      const b = await buildProject(fromTs, { sql: { dialect } });
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
      // The import indents a template's lines under its declaration; the statements are otherwise the same.
      expect(squeeze(a.doc)).toEqual(squeeze(b.doc));
      expect(a.doc!.objects.length).toBeGreaterThan(2);
    });
  }

  let mixed: string;
  beforeAll(async () => {
    mixed = await project("mixed", {
      "app.ts": `import { schema, view } from "@intentius/chant-lexicon-sql/postgres";
export const app = schema\`CREATE SCHEMA app\`;
export const activeUsers = view\`CREATE VIEW app.active_users AS SELECT id FROM app.users\`;
`,
      "users.sql": "CREATE TABLE app.users (id bigint PRIMARY KEY);\nCREATE TABLE app.notes (user_id bigint REFERENCES app.users (id));\n",
    });
    dirs.push(mixed);
  });

  test("a file's object and a template reference each other, and the order comes from the references", async () => {
    const { errors, doc } = await buildProject(mixed);
    expect(errors).toEqual([]);
    const objects = new Map(doc!.objects.map((o) => [o.export as string, o]));
    // The file's table names the template's schema; the template's view names the file's table as text.
    expect(objects.get("users")!.dependsOn).toEqual(["app"]);
    expect(objects.get("notes")!.dependsOn).toEqual(["app", "users"]);
    expect(objects.get("activeUsers")!.dependsOn).toEqual(["users"]);
    expect(doc!.applyOrder).toEqual(["app", "users", "activeUsers", "notes"]);
  });

  test("a statement the build cannot read is a build error naming the file and the statement", async () => {
    const dir = await project("bad", { "app.ts": `import { schema } from "@intentius/chant-lexicon-sql/postgres";\nexport const app = schema\`CREATE SCHEMA app\`;\n`, "bad.sql": "CREATE TABLE app.t (id int);\nDROP TABLE app.old;\n" });
    dirs.push(dir);
    const { errors } = await buildProject(dir);
    expect(errors.join("\n")).toMatch(/src\/bad\.sql: a statement chant cannot read as declarations:\n {2}- not a statement that declares an object: DROP TABLE app\.old/);
  });

  test("an object declared in a file and a template both is an error naming both", async () => {
    const dir = await project("twice", { "app.ts": `import { table } from "@intentius/chant-lexicon-sql/postgres";\nexport const accounts = table\`CREATE TABLE app.users (id int)\`;\n`, "users.sql": "CREATE TABLE app.users (id int);\n" });
    dirs.push(dir);
    const { errors } = await buildProject(dir);
    expect(errors.join("\n")).toMatch(/app\.users is declared twice, here and as accounts/);
  });

  test("a file marked chant-discovery-skip is not read", async () => {
    const dir = await project("skip", { "app.ts": `import { schema } from "@intentius/chant-lexicon-sql/postgres";\nexport const app = schema\`CREATE SCHEMA app\`;\n`, "seed.sql": "-- chant-discovery-skip\nINSERT INTO app.t VALUES (1);\n" });
    dirs.push(dir);
    const { errors, doc } = await buildProject(dir);
    expect(errors).toEqual([]);
    expect(doc!.applyOrder).toEqual(["app"]);
  });
});

describe("SQL that is not schema, in a build of the project root (#3713)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("a .sql file under a migrations directory, at any depth, is not read", async () => {
    const dir = await project("migrations", {
      "app.ts": `import { schema, table } from "@intentius/chant-lexicon-sql/postgres";\nexport const app = schema\`CREATE SCHEMA app\`;\nexport const users = table\`CREATE TABLE app.users (id bigint)\`;\n`,
    });
    dirs.push(dir);
    await mkdir(join(dir, "src", "migrations", "20261010T0000-add-email"), { recursive: true });
    await writeFile(join(dir, "src", "migrations", "20261010T0000-add-email", "migration.sql"), "ALTER TABLE app.users ADD COLUMN email text;\n");
    await mkdir(join(dir, "src", "prisma", "migrations", "0001_init"), { recursive: true });
    await writeFile(join(dir, "src", "prisma", "migrations", "0001_init", "migration.sql"), "CREATE TABLE app.users (id bigint);\n");
    const { errors, doc } = await buildProject(dir);
    expect(errors).toEqual([]);
    expect(doc!.applyOrder).toEqual(["app", "users"]);
  });

  test("a file named migrations.sql, or in a directory that only starts with the word, is still read", async () => {
    const dir = await project("not-migrations", { "app.ts": `import { schema } from "@intentius/chant-lexicon-sql/postgres";\nexport const app = schema\`CREATE SCHEMA app\`;\n` });
    dirs.push(dir);
    await writeFile(join(dir, "src", "migrations.sql"), "CREATE TABLE app.a (id bigint);\n");
    await mkdir(join(dir, "src", "migrations-old"), { recursive: true });
    await writeFile(join(dir, "src", "migrations-old", "b.sql"), "CREATE TABLE app.b (id bigint);\n");
    const { errors, doc } = await buildProject(dir);
    expect(errors).toEqual([]);
    expect([...doc!.applyOrder].sort()).toEqual(["a", "app", "b"]);
  });
});

describe("references between a file's objects", () => {
  test("a bare name where SQL names an object is a reference, and a cycle is an error", async () => {
    const { sqlFileEntities } = await import("./sql-files");
    const entities = sqlFileEntities("postgres", [
      { origin: "a.sql", ddl: "CREATE TABLE orders (user_id int REFERENCES users (id));\nCREATE TABLE users (id int PRIMARY KEY);\nCREATE VIEW recent AS SELECT * FROM orders JOIN users ON true;" },
    ]);
    const deps = (n: string) => ((entities.get(n) as unknown as { dependsOn: Array<{ sqlName: string }> }).dependsOn).map((d) => d.sqlName);
    expect(deps("orders")).toEqual(["users"]);
    expect(deps("recent")).toEqual(["orders", "users"]);
    expect(() => sqlFileEntities("postgres", [{ origin: "b.sql", ddl: "CREATE TABLE a (b int REFERENCES b (id), id int PRIMARY KEY);\nCREATE TABLE b (a int REFERENCES a (id), id int PRIMARY KEY);" }])).toThrow(/reference each other/);
  });
});
