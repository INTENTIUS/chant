/**
 * Keeping `sql-types.d.ts` current (#3751): `chant sql types --check` and the
 * SQL102 post-synth check, over a scratch project. The project imports the
 * workspace's sql lexicon through a `node_modules` link, as an installed
 * project would.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { runTypes } from "./sql-types-command";
import { sqlTypesPath } from "./sql-types";
import { sql102 } from "./lint/post-synth/sql102";

const repoNodeModules = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../node_modules");

const schema = (amount: string) =>
  'import { schema, table } from "@intentius/chant-lexicon-sql/postgres";\n' +
  "export const shop = schema`CREATE SCHEMA shop`;\n" +
  'export const orders = table<"shop.orders">`CREATE TABLE ${shop}.orders (id bigint PRIMARY KEY, ' +
  `amount ${amount})\`;\n`;

describe("sql-types.d.ts staleness", () => {
  let root: string;
  let cwd: string;
  let errors: string[];

  const write = (amount: string) => writeFileSync(join(root, "src", "schema.ts"), schema(amount));
  const types = async (...args: string[]) => {
    process.chdir(root);
    return runTypes({ verb: "types", rawArgs: args });
  };

  beforeEach(() => {
    cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3751-stale-")));
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync(repoNodeModules, join(root, "node_modules"), "dir");
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["sql"], sourceDir: "src", sql: { dialect: "postgres" } }));
    write("numeric(12,2)");
    errors = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.NO_COLOR = "1";
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    delete process.env.NO_COLOR;
  });

  test("--check exits 0 on a current file, and 1 naming it once the schema changes", async () => {
    expect(await types()).toBe(0);
    const file = join(root, "src", "sql-types.d.ts");
    const written = readFileSync(file, "utf8");
    expect(await types("--check")).toBe(0);

    write("bigint");
    expect(await types("--check")).toBe(1);
    expect(errors.join("\n")).toContain("src/sql-types.d.ts differs");
    expect(readFileSync(file, "utf8")).toBe(written);
  });

  test("--check on a missing file exits 1 and writes nothing", async () => {
    expect(await types("--check")).toBe(1);
    expect(errors.join("\n")).toContain("src/sql-types.d.ts does not exist");
    expect(() => readFileSync(join(root, "src", "sql-types.d.ts"))).toThrow();
  });

  test("--check honours --output", async () => {
    expect(await types("--output", "out/types.d.ts")).toBe(0);
    expect(await types("--check", "--output", "out/types.d.ts")).toBe(0);
    write("bigint");
    expect(await types("--check", "--output", "out/types.d.ts")).toBe(1);
    expect(errors.join("\n")).toContain("out/types.d.ts");
  });

  test("lint reports SQL102 for a stale file, and nothing for a current or missing one", async () => {
    const ids = async () => (await lintCommand({ path: root, format: "stylish" })).diagnostics.map((d) => d.ruleId);
    expect(await ids()).not.toContain("SQL102");

    expect(await types()).toBe(0);
    expect(await ids()).not.toContain("SQL102");

    write("bigint");
    const result = await lintCommand({ path: root, format: "stylish" });
    const diag = result.diagnostics.find((d) => d.ruleId === "SQL102");
    expect(diag, result.output).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(diag!.message).toContain("sql-types.d.ts");

    expect(await types()).toBe(0);
    expect(await ids()).not.toContain("SQL102");
  });
});

describe("SQL102 on a hand-built context", () => {
  test("is silent without a project directory", () => {
    const ctx = { outputs: new Map(), entities: new Map(), buildResult: { outputs: new Map(), entities: new Map(), warnings: [], errors: [], sourceFileCount: 0 } };
    expect(sql102.check(ctx)).toEqual([]);
  });

  test("the default path is the source directory, else the project root", () => {
    expect(sqlTypesPath("/p", { sourceDir: "src" })).toBe("/p/src/sql-types.d.ts");
    expect(sqlTypesPath("/p", {})).toBe("/p/sql-types.d.ts");
  });
});
