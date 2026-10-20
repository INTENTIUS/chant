/**
 * The sql lint rules run in a project whose `typescript` is TypeScript 7
 * (chant #3864).
 *
 * TypeScript 7's `typescript` package has no JS compiler API. chant core keeps
 * its own 5.x and parses every file with it, but a rule that imported
 * `typescript` itself got the project's copy, and every rule threw
 * `ts.isImportDeclaration is not a function`, so `chant graph` refused the
 * project. The rules now take `ts` from `@intentius/chant/lint/typescript`.
 *
 * In this repo the rules and core resolve the same `typescript`, so the test
 * lays out the install a user gets: a project whose `node_modules/typescript`
 * is TypeScript 7 (the root's `typescript-native` alias), a copy of this
 * lexicon in it (a copy, because module resolution follows the real path),
 * and chant core keeping its own TypeScript 5. It then runs the rules the way
 * the CLI does, in a separate node process under tsx, over the examples.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const lexiconDir = fileURLToPath(new URL("../../../", import.meta.url));
const repoRoot = join(lexiconDir, "..", "..");
const nodeModules = join(repoRoot, "node_modules");
const ts7 = join(nodeModules, "typescript-native");
const tsxLoader = join(nodeModules, "tsx", "dist", "loader.mjs");

const examples = ["postgres-getting-started", "getting-started"].map((name) => join(lexiconDir, "examples", name, "src"));

/** Runs in the child: every rule over every example file, reporting what threw. */
const RUNNER = `
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFile } from "@intentius/chant/lint/parser";
import { rules } from "@intentius/chant-lexicon-sql/lint/rules/index";

// The \`typescript\` the lexicon would get from a bare import.
const lexiconTs = createRequire(process.argv[3])("typescript/package.json").version;
const threw = [];
let checked = 0;
for (const dir of JSON.parse(process.argv[2])) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const filePath = join(dir, name);
    const sourceFile = parseFile(filePath);
    for (const rule of rules) {
      try {
        rule.check({ sourceFile, entities: [], filePath });
        checked++;
      } catch (err) {
        threw.push(rule.id + " " + name + ": " + (err instanceof Error ? err.message : String(err)));
      }
    }
  }
}
console.log(JSON.stringify({ lexiconTs, checked, threw }));
`;

const ready = existsSync(ts7) && existsSync(tsxLoader);

describe.skipIf(!ready)("sql lint rules in a TypeScript 7 project (#3864)", () => {
  let project: string;
  let lexiconPackageJson: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "chant-sql-ts7-"));
    const modules = join(project, "node_modules");
    mkdirSync(join(modules, "@intentius"), { recursive: true });
    symlinkSync(ts7, join(modules, "typescript"), "dir");
    symlinkSync(join(repoRoot, "packages", "core"), join(modules, "@intentius", "chant"), "dir");
    for (const dep of ["pg", "zod"]) symlinkSync(join(nodeModules, dep), join(modules, dep), "dir");
    const copy = join(modules, "@intentius", "chant-lexicon-sql");
    lexiconPackageJson = join(copy, "package.json");
    cpSync(join(lexiconDir, "src"), join(copy, "src"), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.ts"),
    });
    cpSync(join(lexiconDir, "package.json"), join(copy, "package.json"));
    writeFileSync(join(project, "run.mts"), RUNNER);
  });

  afterAll(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("no rule throws, and the lexicon really sees TypeScript 7", () => {
    for (const dir of examples) expect(readdirSync(dir).length).toBeGreaterThan(0);
    // The copy carries src/ only, so the lexicon resolves through its `development` export (#3981).
    const out = execFileSync(process.execPath, ["--conditions=development", "--import", `file://${tsxLoader}`, join(project, "run.mts"), JSON.stringify(examples), lexiconPackageJson], {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    });
    const { lexiconTs, checked, threw } = JSON.parse(out.trim().split("\n").pop()!);
    expect(lexiconTs).toMatch(/^7\./);
    expect(threw).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
