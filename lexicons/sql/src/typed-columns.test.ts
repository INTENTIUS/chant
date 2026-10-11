/**
 * Typed columns reach plain `tsc` (#3751). Each fixture project under
 * `test-fixtures/typed-columns/` is built the way `chant sql types` builds
 * it, its declarations rendered and compared with the committed
 * `src/sql-types.d.ts`, and then the project is type-checked with the
 * compiler options a strict application uses. tsc must report exactly the
 * errors the fixture plants: a misspelled column, a foreign key between
 * types that do not compare, a Nullable column in a sort key, and `RowOf` of
 * a name no declaration has or of a relation with no name.
 *
 * The fixtures sit outside `src/` and are excluded from the repo's
 * typecheck: their declarations augment `SqlSchema`, which would leak into
 * every other program, and their errors are on purpose.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { resolveProjectBuildOptions } from "@intentius/chant/cli/build-options";
import { sqlPlugin } from "./plugin";
import { sqlSerializer } from "./serializer";
import { renderSqlTypes, SQL_TYPES_FILE } from "./sql-types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixtures = join(here, "..", "test-fixtures", "typed-columns");

async function rendered(dir: string): Promise<string> {
  const options = resolveProjectBuildOptions({ config: {}, configDir: dir, plugins: [sqlPlugin], modes: { fold: true, sandbox: false } });
  const result = await build(join(dir, "src"), [sqlSerializer], undefined, options);
  expect(result.errors.map(String)).toEqual([]);
  return renderSqlTypes(result.entities, { projectDir: dir });
}

/** Every error tsc reports in the fixture's own files, as `file(line): TScode message`. */
function tscErrors(dir: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    isolatedModules: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules", "@types")],
    paths: {
      "@intentius/chant": [join(repoRoot, "packages/core/src/index.ts")],
      "@intentius/chant/*": [join(repoRoot, "packages/core/src/*")],
      "@intentius/chant-lexicon-sql/*": [join(repoRoot, "lexicons/sql/src/*")],
    },
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

describe("chant sql types, through tsc", () => {
  test("Postgres: a misspelled column, a foreign key of another category and RowOf of no declaration fail; the rest compiles", async () => {
    const dir = join(fixtures, "postgres");
    expect(await rendered(dir)).toBe(readFileSync(join(dir, "src", SQL_TYPES_FILE), "utf8"));
    expect(tscErrors(dir)).toEqual([
      expect.stringMatching(/^checks\/misspelled\.ts\(4\): TS2551 Property 'emial' does not exist .* Did you mean 'email'\?$/),
      expect.stringMatching(/^checks\/rows\.ts\(23\): TS2344 Type '"shop\.ordrs"' does not satisfy the constraint/),
      expect.stringMatching(/^checks\/rows\.ts\(24\): TS2344 Type 'PostgresTable<Unnamed>' does not satisfy the constraint/),
      expect.stringMatching(/^src\/refunds\.ts\(8\): TS2345 Argument of type 'Column<"bigint", .*' is not assignable to parameter of type 'KeyColumn<"S">'/),
    ]);
  }, 120_000);

  test("ClickHouse: a Nullable column in a materialized view's ORDER BY and a misspelled column fail; the rest compiles", async () => {
    const dir = join(fixtures, "clickhouse");
    expect(await rendered(dir)).toBe(readFileSync(join(dir, "src", SQL_TYPES_FILE), "utf8"));
    expect(tscErrors(dir)).toEqual([
      expect.stringMatching(/^checks\/rows\.ts\(18\): TS2551 Property 'contry' does not exist .* Did you mean 'country'\?$/),
      expect.stringMatching(/^src\/by-country\.ts\(7\): TS2345 Argument of type 'Column<"Nullable\(String\)", .*' is not assignable to parameter of type 'NotNullColumn'/),
    ]);
  }, 120_000);
});
