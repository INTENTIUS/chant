import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lexicon source takes the TypeScript compiler API from
 * `@intentius/chant/lint/typescript`, never from `typescript` (chant #3864).
 *
 * A bare `typescript` import in a published lexicon resolves to the project's
 * copy. On TypeScript 7 that copy has no JS compiler API, so every sql lint
 * rule threw `ts.isImportDeclaration is not a function` and `chant graph`
 * refused the project. Core parses with its own 5.x, and a rule has to test
 * nodes with that same module. Tests are exempt: they run in this repo, where
 * `typescript` is 5.x.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const lexiconsDir = join(repoRoot, "lexicons");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const BARE_TYPESCRIPT = /^\s*(import|export)\b[^;]*?\bfrom\s+["']typescript["']|\b(require|import)\(\s*["']typescript["']\s*\)/m;

describe("lexicon source imports TypeScript through chant (#3864)", () => {
  test("no lexicon src file imports `typescript` directly", () => {
    const offenders = readdirSync(lexiconsDir)
      .map((name) => join(lexiconsDir, name, "src"))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      .flatMap(sourceFiles)
      .filter((file) => BARE_TYPESCRIPT.test(readFileSync(file, "utf-8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders, 'import { ts } from "@intentius/chant/lint/typescript" instead').toEqual([]);
  });
});
