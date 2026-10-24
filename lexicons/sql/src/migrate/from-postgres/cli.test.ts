/**
 * `chant migrate --from sql/postgres --to sql/clickhouse` in-process, for the
 * second Done-when box of #4399: every decision is a SARIF diagnostic, and
 * `--strict` exits 1 while one is open. Also the naming of the two sides, the
 * member directory as a source, and the workspace links written beside the
 * output. `--validate` needs the emulator: `validate.e2e.test.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "@intentius/chant/cli/parse-args";
import { runMigrate } from "@intentius/chant/cli/handlers/migrate";

const dir = mkdtempSync(join(tmpdir(), "migrate-pg-ch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const SCHEMA = "CREATE TABLE users (id bigint PRIMARY KEY, email text NOT NULL, status text NOT NULL, bio text);\n";
let n = 0;

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function migrate(argv: string[]) {
  const args = parseArgs(["migrate", ...argv]);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const code = await runMigrate({ args, plugins: [], serializers: [] });
  return { code, stderr: err.mock.calls.map((c) => String(c[0])).join("\n"), stdout: out.mock.calls.map((c) => String(c[0])).join("") };
}

const input = write(join(dir, "schema.sql"), SCHEMA);
const sides = ["--from", "sql/postgres", "--to", "sql/clickhouse"];

describe("chant migrate --from sql/postgres --to sql/clickhouse", () => {
  test("writes declarations, exits 0 and prints the review summary", async () => {
    const out = join(dir, `plain-${++n}.ts`);
    const r = await migrate([input, ...sides, "--output", out]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("export const users = table`");
    expect(r.stderr).toContain("## Migration report");
    expect(r.stderr).toContain("SQLRV001");
    // The GitLab pair's advice does not appear.
    expect(r.stderr).not.toContain("GitLab");
  });

  test("--use-composites writes a CdcMirror call; --emit sql writes DDL; the default for this pair is ts", async () => {
    const ts = join(dir, `c-${++n}.ts`);
    expect((await migrate([input, ...sides, "--use-composites", "--output", ts])).code).toBe(0);
    expect(readFileSync(ts, "utf8")).toContain('columns: "id Int64, email String, status String, bio Nullable(String)"');
    const sql = join(dir, `c-${++n}.sql`);
    expect((await migrate([input, ...sides, "--emit", "sql", "--output", sql])).code).toBe(0);
    expect(readFileSync(sql, "utf8")).toMatch(/^CREATE TABLE users/);
  });

  test("--report writes every finding as SARIF with its rule id, entity and the source file", async () => {
    const report = join(dir, `r-${++n}.sarif`);
    const r = await migrate([input, ...sides, "--output", join(dir, `r-${n}.ts`), "--report", report]);
    expect(r.code).toBe(0);
    const sarif = JSON.parse(readFileSync(report, "utf8")) as { runs: Array<{ results: Array<{ ruleId: string; level: string; message: { text: string }; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> };
    const results = sarif.runs[0]!.results;
    expect(results.map((x) => x.ruleId).sort()).toEqual(["SQLRV001", "SQLRV002", "SQLRV003", "SQLRV004"]);
    expect(results.every((x) => x.level === "warning")).toBe(true);
    expect(results.every((x) => x.locations[0]!.physicalLocation.artifactLocation.uri.endsWith("schema.sql"))).toBe(true);
    expect(results.find((x) => x.ruleId === "SQLRV003")!.message.text).toContain("users.bio");
  });

  test("the report describes each rule from the catalog, with the documentation it rests on", async () => {
    const report = join(dir, `m-${++n}.sarif`);
    await migrate([input, ...sides, "--output", join(dir, `m-${n}.ts`), "--report", report]);
    const sarif = JSON.parse(readFileSync(report, "utf8")) as { runs: Array<{ tool: { driver: { rules: Array<{ id: string; shortDescription: { text: string }; helpUri: string }> } } }> };
    const rule = sarif.runs[0]!.tool.driver.rules.find((r) => r.id === "SQLRV001")!;
    expect(rule.shortDescription.text).toContain("sort-key");
    expect(rule.helpUri).toContain("clickhouse.com/docs");
  });

  test("--strict exits 1 while a warning is open, and the report then marks them errors", async () => {
    const report = join(dir, `s-${++n}.sarif`);
    const r = await migrate([input, ...sides, "--strict", "--output", join(dir, `s-${n}.ts`), "--report", report]);
    expect(r.code).toBe(1);
    const sarif = JSON.parse(readFileSync(report, "utf8")) as { runs: Array<{ results: Array<{ level: string }> }> };
    expect(sarif.runs[0]!.results.every((x) => x.level === "error")).toBe(true);
  });

  test("a side with a slash that the lexicon does not know is refused by name", async () => {
    const r = await migrate([input, "--from", "sql/mysql", "--to", "sql/clickhouse"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not support migration from "sql/mysql"');
    const back = await migrate([input, "--from", "sql/postgres", "--to", "sql/postgres"]);
    expect(back.code).toBe(1);
    expect(back.stderr).toContain('does not support migration from "sql/postgres"');
  });

  test("--emit sql is refused for a target that is not a sql lexicon", async () => {
    const r = await migrate([input, "--emit", "sql"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a sql target");
  });

  test("a file that is not Postgres DDL is refused by name", async () => {
    const ch = write(join(dir, "ch.sql"), "CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id;\n");
    const r = await migrate([ch, ...sides]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not look like sql/postgres source");
  });
});

describe("in a workspace", () => {
  function workspace() {
    const root = join(dir, `ws-${++n}`);
    write(join(root, "chant.workspace.json"), JSON.stringify({ name: "shop", schema: 1, members: [{ name: "db", dir: "db", kind: "chant" }, { name: "mirror", dir: "mirror", kind: "chant" }] }, null, 2) + "\n");
    write(join(root, "db/chant.config.ts"), "");
    write(join(root, "mirror/chant.config.ts"), "");
    return root;
  }
  const links = (root: string) => (JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8")) as { members: Array<{ name: string; links?: Array<{ member: string; output: string }> }> }).members.find((m) => m.name === "mirror")!.links;

  test("the mirror member links each mirrored column to the Postgres member's output, once", async () => {
    const root = workspace();
    const source = write(join(root, "db/schema.sql"), SCHEMA);
    const out = join(root, "mirror/src/mirrors.ts");
    const first = await migrate([source, ...sides, "--use-composites", "--output", out]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("Workspace links: added 4 links from member mirror to db");
    expect(links(root)).toEqual(["id", "email", "status", "bio"].map((c) => ({ member: "db", output: `public.users.${c}` })));
    const again = await migrate([source, ...sides, "--use-composites", "--output", out]);
    expect(again.stderr).toContain("already links every output");
    expect(links(root)).toHaveLength(4);
  });

  test("a table added to the source adds only its links; stdout output writes none and says so", async () => {
    const root = workspace();
    const source = write(join(root, "db/schema.sql"), SCHEMA);
    const out = join(root, "mirror/mirrors.ts");
    await migrate([source, ...sides, "--output", out]);
    write(source, `${SCHEMA}CREATE TABLE tags (id bigint PRIMARY KEY, label text NOT NULL);\n`);
    const r = await migrate([source, ...sides, "--output", out]);
    expect(r.stderr).toContain("added 2 links");
    expect(links(root)).toHaveLength(6);
    const toStdout = await migrate([source, ...sides]);
    expect(toStdout.stderr).toContain("pass --output inside the ClickHouse member");
    expect(toStdout.stdout).toContain("export const users");
  });

  test("a member directory or a TypeScript file is a source: its project is built and its tables translated", async () => {
    const example = join(import.meta.dirname, "../../../examples/postgres-cdc-source");
    for (const path of [example, join(example, "src/shop.ts")]) {
      const out = join(dir, `ts-${++n}.ts`);
      const r = await migrate([path, ...sides, "--use-composites", "--output", out]);
      expect(r.code, r.stderr).toBe(0);
      const text = readFileSync(out, "utf8");
      expect(text).toContain("export const customers = CdcMirror({");
      expect(text).toContain("export const orders = CdcMirror({");
      expect(text).toContain("// FOREIGN KEY (customer_id) REFERENCES shop.customers (id)");
      // The output sits in a temporary directory, outside any member of a workspace above the example: no link is written.
      expect(r.stderr).not.toContain("added");
    }
  });
});
