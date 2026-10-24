/**
 * `chant migrate` naming and the target-server `--validate` (#4399): a side is
 * `lexicon` or `lexicon/dialect`, a directory is a source only when the
 * lexicon says so, and a result's own `validate` replaces the external linter.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lexiconOfSide, migrateCommand } from "./migrate";
import type { LexiconPlugin, MigrationResult, MigrationSource } from "../../lexicon";

const seen: Array<{ from: string; to: string | undefined }> = [];

function sqlPlugin(over: { directory?: boolean; result?: Partial<MigrationResult>; transform?: MigrationSource["transform"] } = {}): LexiconPlugin {
  return {
    name: "sql",
    serializer: { name: "sql", rulePrefix: "SQL", serialize: () => "" },
    async generate() {},
    async validate() {},
    async coverage() {},
    async package() {},
    migrationSource(from: string, to?: string) {
      seen.push({ from, to });
      if (from !== "sql/postgres" || (to !== undefined && to !== "sql/clickhouse")) return undefined;
      return {
        detect: (content: string) => content.includes("CREATE TABLE"),
        ...(over.directory ? { directory: true } : {}),
        transform: over.transform ?? (async () => ({ output: "-- ddl\n", provenance: [], diagnostics: [], ...over.result })),
      };
    },
  };
}

const base = { emit: "sql" as const, strict: false, validate: false, useComposites: false };

describe("lexiconOfSide", () => {
  test("is the part before the slash", () => {
    expect(lexiconOfSide("sql/clickhouse")).toBe("sql");
    expect(lexiconOfSide("gitlab")).toBe("gitlab");
  });
});

describe("migrateCommand with lexicon/dialect sides", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-migrate-dialect-"));
    seen.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = () => {
    const f = join(dir, "schema.sql");
    writeFileSync(f, "CREATE TABLE t (id int);");
    return f;
  };

  test("finds the plugin by the lexicon part, and hands the source both sides as written", async () => {
    const r = await migrateCommand({ ...base, sourceFile: file(), from: "sql/postgres", to: "sql/clickhouse", output: join(dir, "out.sql"), plugins: [sqlPlugin()] });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([{ from: "sql/postgres", to: "sql/clickhouse" }]);
    expect(readFileSync(join(dir, "out.sql"), "utf8")).toBe("-- ddl\n");
  });

  test("a dialect the lexicon does not know is refused by name", async () => {
    const r = await migrateCommand({ ...base, sourceFile: file(), from: "sql/postgres", to: "sql/mysql", plugins: [sqlPlugin()] });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('Lexicon "sql/mysql" does not support migration from "sql/postgres"');
  });

  test("creates the output's directory", async () => {
    const out = join(dir, "a/b/out.sql");
    const r = await migrateCommand({ ...base, sourceFile: file(), from: "sql/postgres", to: "sql/clickhouse", output: out, plugins: [sqlPlugin()] });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("-- ddl\n");
  });

  test("a directory is refused unless the source reads directories; then detect is skipped and content is empty", async () => {
    const member = join(dir, "db");
    mkdirSync(member);
    const refused = await migrateCommand({ ...base, sourceFile: member, from: "sql/postgres", to: "sql/clickhouse", plugins: [sqlPlugin()] });
    expect(refused.exitCode).toBe(1);
    expect(refused.error).toContain("is a directory");
    let got: { content: string; sourceFile?: string } | undefined;
    const ok = await migrateCommand({
      ...base,
      sourceFile: member,
      from: "sql/postgres",
      to: "sql/clickhouse",
      output: join(dir, "o.sql"),
      plugins: [sqlPlugin({ directory: true, transform: async (content, opts) => ((got = { content, sourceFile: opts.sourceFile }), { output: "x", provenance: [], diagnostics: [] }) })],
    });
    expect(ok.exitCode).toBe(0);
    expect(got).toEqual({ content: "", sourceFile: member });
  });
});

describe("--validate with a result that checks itself", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-migrate-validate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (result: Partial<MigrationResult>, extra: { strict?: boolean } = {}) => {
    const f = join(dir, "schema.sql");
    writeFileSync(f, "CREATE TABLE t (id int);");
    return migrateCommand({ ...base, ...extra, validate: true, sourceFile: f, from: "sql/postgres", to: "sql/clickhouse", output: join(dir, "o.sql"), plugins: [sqlPlugin({ result })] });
  };

  test("a clean check passes and its diagnostics join the result", async () => {
    const r = await run({ validate: async () => [] });
    expect(r.exitCode).toBe(0);
  });

  test("a refused statement fails the run without --strict, and is in the diagnostics", async () => {
    const r = await run({ validate: async () => [{ ruleId: "SQLRV012", severity: "error", message: "t: the emulator rejected the statement." }] });
    expect(r.exitCode).toBe(1);
    expect(r.diagnostics.map((d) => d.ruleId)).toEqual(["SQLRV012"]);
  });

  test("a server that cannot start is a validation that did not run, which fails", async () => {
    const r = await run({
      validate: async () => {
        throw new Error("Docker is not available, so the ClickHouse emulator cannot start");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("--validate did not run: Docker is not available");
  });

  test("without --validate the check is not run", async () => {
    let ran = false;
    const f = join(dir, "schema.sql");
    writeFileSync(f, "CREATE TABLE t (id int);");
    const r = await migrateCommand({
      ...base,
      sourceFile: f,
      from: "sql/postgres",
      to: "sql/clickhouse",
      output: join(dir, "o.sql"),
      plugins: [sqlPlugin({ result: { validate: async () => ((ran = true), []) } })],
    });
    expect(r.exitCode).toBe(0);
    expect(ran).toBe(false);
  });
});
