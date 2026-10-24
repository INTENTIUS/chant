/**
 * The generated Drizzle schemas type-check against drizzle-orm (#4401), and a
 * select over `examples/postgres-getting-started` has the row its declaration
 * gives. The goldens are `test-fixtures/drizzle/*\/schema.ts`
 * (`drizzle.test.ts` keeps them equal to what `renderDrizzle` writes);
 * `postgres-getting-started/rows.ts` holds the row-type assertions.
 *
 * drizzle-orm is not a dependency of this repository, so the test runs only
 * where it resolves from the fixtures (install `drizzle-orm@0.45.4`, the
 * version `DRIZZLE_ORM_CHECKED` names, and `typescript`), and is skipped
 * otherwise.
 */

import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixtures = join(here, "..", "test-fixtures", "drizzle");

function drizzleInstalled(): boolean {
  try {
    createRequire(join(fixtures, "x.js")).resolve("drizzle-orm/package.json");
    return true;
  } catch {
    return false;
  }
}

/** Every error tsc reports in the fixture's files, as `file(line): TScode message`. */
function tscErrors(dir: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules", "@types")],
  };
  const files = ts.sys.readDirectory(dir, [".ts"]);
  const program = ts.createProgram(files, options);
  const out: string[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      out.push(`${relative(dir, file)}(${line + 1}): TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0]}`);
    }
  }
  return out.sort();
}

describe.skipIf(!drizzleInstalled())("the generated Drizzle schema, through tsc", () => {
  test("examples/postgres-getting-started: the schema compiles and a select has the declared row type", () => {
    expect(tscErrors(join(fixtures, "postgres-getting-started"))).toEqual([]);
  }, 120_000);

  test("every mapping compiles, including two tables that reference each other", () => {
    expect(tscErrors(join(fixtures, "mappings"))).toEqual([]);
  }, 120_000);
});
