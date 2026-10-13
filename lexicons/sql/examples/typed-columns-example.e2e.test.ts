/**
 * The postgres-typed-columns example (#3788): its committed sql-types.d.ts is
 * current, plain tsc passes on it, and a planted misspelled column fails.
 *
 * The example has its own tsconfig and is excluded from the repo-wide
 * typecheck, because its declarations augment the sql lexicon's `SqlSchema`
 * and would leak into every other program.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { resolveProjectBuildOptions } from "@intentius/chant/cli/build-options";
import { readFileSync } from "node:fs";
import { sqlPlugin } from "../src/plugin";
import { sqlSerializer } from "../src/serializer";
import { renderSqlTypes, SQL_TYPES_FILE } from "../src/sql-types";

const dir = join(import.meta.dirname, "postgres-typed-columns");

/** Errors tsc reports for the example's tsconfig, plus any extra files. */
function tscErrors(extra: string[] = []): string[] {
  const configPath = join(dir, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const program = ts.createProgram([...parsed.fileNames, ...extra], parsed.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0]}`);
}

describe("postgres-typed-columns example", () => {
  test("sql-types.d.ts is what `chant sql types` renders", async () => {
    const options = resolveProjectBuildOptions({ config: {}, configDir: dir, plugins: [sqlPlugin], modes: { fold: true, sandbox: false } });
    const result = await build(join(dir, "src"), [sqlSerializer], undefined, options);
    expect(result.errors.map(String)).toEqual([]);
    expect(renderSqlTypes(result.entities, { projectDir: dir })).toBe(readFileSync(join(dir, "src", SQL_TYPES_FILE), "utf8"));
  }, 120_000);

  test("plain tsc passes on the example", () => {
    expect(tscErrors()).toEqual([]);
  }, 120_000);

  test("a planted misspelled column fails tsc", () => {
    const planted = join(mkdtempSync(join(tmpdir(), "typed-columns-")), "planted.ts");
    writeFileSync(planted, `import { customers } from ${JSON.stringify(join(dir, "src", "schema"))};\nexport const bad = customers.columns.emial;\n`);
    const errors = tscErrors([planted]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^TS2551 Property 'emial' does not exist .* Did you mean 'email'\?$/);
  }, 120_000);
});
