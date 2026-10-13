/**
 * #3870: a project's own `lint.policies`, written against
 * `@intentius/chant-lexicon-sql/read`, fail `chant lint` and `chant build` on
 * a table that breaks them, and `tsc` checks the policy itself.
 *
 * Each case copies `examples/postgres-policies` into a temporary project that
 * reaches the workspace packages through a `node_modules` link, as an
 * installed project would.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { ts } from "@intentius/chant/lint/typescript";
import { sqlPlugin, sqlSerializer } from "@intentius/chant-lexicon-sql";

const here = import.meta.dirname;
const example = resolve(here, "..", "examples", "postgres-policies");
const repoNodeModules = resolve(here, "..", "..", "..", "node_modules");

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3870-")));
  for (const f of ["chant.config.ts", "policies", "src"]) cpSync(join(example, f), join(root, f), { recursive: true });
  symlinkSync(repoNodeModules, join(root, "node_modules"), "dir");
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.NO_COLOR;
});

/** Drop `sessions.created_at` from the example's schema. */
function breakSessions(): void {
  const file = join(root, "src", "app.ts");
  const text = readFileSync(file, "utf-8").replace(
    "    account_id bigint NOT NULL REFERENCES ${accounts} (id),\n    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()\n",
    "    account_id bigint NOT NULL REFERENCES ${accounts} (id)\n",
  );
  expect(text).not.toContain("TIMESTAMP WITH TIME ZONE");
  writeFileSync(file, text);
}

const policyIds = (diags: Array<{ ruleId: string }>) => diags.map((d) => d.ruleId).filter((id) => id.startsWith("ORG-"));

describe("project policies over the sql read API (#3870)", () => {
  test("chant lint: the example is clean, and a table without created_at fails", async () => {
    const clean = await lintCommand({ path: join(root, "src"), format: "stylish" });
    expect(policyIds(clean.diagnostics), clean.output).toEqual([]);

    breakSessions();
    const result = await lintCommand({ path: join(root, "src"), format: "stylish" });
    expect(result.success).toBe(false);
    const diag = result.diagnostics.find((d) => d.ruleId === "ORG-CREATED-AT");
    expect(diag, result.output).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(diag!.message).toContain("app.sessions has no created_at column");
    expect(diag!.file).toBe(join(root, "src", "app.ts"));
  });

  test("chant lint applies lint.rules to a policy's id", async () => {
    breakSessions();
    writeFileSync(
      join(root, "chant.config.ts"),
      readFileSync(join(root, "chant.config.ts"), "utf-8").replace(
        'lint: { policies: ["policies/columns.ts"] }',
        'lint: { policies: ["policies/columns.ts"], rules: { "ORG-CREATED-AT": "off" } }',
      ),
    );
    const result = await lintCommand({ path: join(root, "src"), format: "stylish" });
    expect(policyIds(result.diagnostics), result.output).toEqual([]);
  });

  test("chant build fails on the same table", async () => {
    breakSessions();
    const result = await buildCommand({ path: join(root, "src"), format: "json", serializers: [sqlSerializer], plugins: [sqlPlugin] });
    expect(result.success).toBe(false);
    expect(result.errors.join("\n")).toContain("[policy:ORG-CREATED-AT] [sessions]");
  });

  // The first case above lints the same files with no env and gets no ORG-COLUMN-COMMENTS finding.
  // (The config is written before any lint here: a loaded chant.config.ts is cached for the process.)
  test("an env-aware policy fires in prod", async () => {
    writeFileSync(
      join(root, "chant.config.ts"),
      readFileSync(join(root, "chant.config.ts"), "utf-8").replace('sql: { dialect: "postgres" },', 'sql: { dialect: "postgres" },\n  ownership: { env: "prod" },'),
    );
    const prod = await lintCommand({ path: join(root, "src"), format: "stylish" });
    expect(prod.diagnostics.filter((d) => d.ruleId === "ORG-COLUMN-COMMENTS").map((d) => d.message), prod.output).toEqual([
      "[accounts] app.accounts.created_at has no comment",
      "[sessions] app.sessions.account_id has no comment",
      "[sessions] app.sessions.created_at has no comment",
    ]);
  });

  test("the ClickHouse policy flags a MergeTree table without created_at, and a Nullable sort key column", async () => {
    rmSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "chant.config.ts"),
      'import type { ChantConfig } from "@intentius/chant";\n' +
        'export default { lexicons: ["sql"], sql: { dialect: "clickhouse" }, lint: { policies: ["policies/clickhouse.ts"], rules: { SQLCH113: "off" } } } satisfies ChantConfig;\n',
    );
    writeFileSync(
      join(root, "src", "schema.ts"),
      'import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";\n' +
        "export const shop = database`CREATE DATABASE shop ENGINE = Atomic`;\n" +
        "export const events = table`CREATE TABLE ${shop}.events (id UInt64, created_at DateTime) ENGINE = MergeTree ORDER BY id`;\n" +
        "export const visits = table`CREATE TABLE ${shop}.visits (id UInt64, ref Nullable(String)) ENGINE = MergeTree ORDER BY (id, ref) SETTINGS allow_nullable_key = 1`;\n",
    );
    const result = await lintCommand({ path: join(root, "src"), format: "stylish" });
    expect(result.diagnostics.filter((d) => d.ruleId === "ORG-CH-CREATED-AT").map((d) => d.message), result.output).toEqual([
      "[visits] shop.visits needs created_at DateTime, not Nullable",
      "[visits] shop.visits.ref is Nullable and in the sort key",
    ]);
  });

  test("tsc checks a policy against the read API's types", () => {
    const policy = join(root, "policies", "columns.ts");
    const check = () => {
      const program = ts.createProgram([policy], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      });
      return ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === policy)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    };
    expect(check()).toEqual([]);
    writeFileSync(policy, readFileSync(policy, "utf-8").replace("c.typeName === TIMESTAMPTZ", "c.typeNmae === TIMESTAMPTZ"));
    expect(check().join("\n")).toMatch(/Property 'typeNmae' does not exist on type 'PostgresColumnInfo'/);
  }, 60_000);
});
