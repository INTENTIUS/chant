/**
 * #3981 — every lexicon publishes compiled JS. Each package export that names
 * a module resolves `default` to `dist/*.js` and keeps `@intentius/chant-source` on the
 * matching `src/*.ts`, which the repository's own tools (vitest, `bin/chant`
 * from source with `--conditions=@intentius/chant-source`, tsc's `customConditions`)
 * resolve. A compiled lexicon that imports another lexicon still on `.ts`
 * would fail under plain node, so the check covers all of them at once.
 *
 * The build has to keep the JS tsc emits (#433 deleted it), the prepack has
 * to run that build, and `files` has to publish `dist/` and not `src/`: the
 * build copies the JSON a compiled module reads (generated lexicon data,
 * vendored schemas) from `src/` to `dist/` (scripts/copy-lexicon-assets.mjs),
 * and `moduleSourceDir` finds it there when the package has no `src/`.
 *
 * Reads package.json and tsconfig.build.json files only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const LEXICONS = readdirSync(join(ROOT, "lexicons")).filter((name) => existsSync(join(ROOT, "lexicons", name, "package.json"))).sort();

interface Manifest {
  name: string;
  files?: string[];
  scripts?: Record<string, string>;
  exports: Record<string, unknown>;
}

function manifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "lexicons", name, "package.json"), "utf-8")) as Manifest;
}

/** What is wrong with one export entry, or nothing. */
function exportProblems(key: string, value: unknown): string[] {
  if (typeof value === "string") {
    // Data and declarations: no module to compile.
    return /\.(json|d\.ts)$/.test(value) ? [] : [`${key}: "${value}" names a module without conditions; give it @intentius/chant-source and default`];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${key}: not a string or a condition object`];
  const entry = value as Record<string, unknown>;
  const problems: string[] = [];
  const { "@intentius/chant-source": sourceTarget, default: dflt } = entry as { "@intentius/chant-source"?: unknown; default?: unknown };
  if (typeof sourceTarget !== "string" || !/^\.\/src\/.+\.ts$/.test(sourceTarget)) {
    problems.push(`${key}: @intentius/chant-source is ${JSON.stringify(sourceTarget)}, not ./src/*.ts`);
  }
  if (typeof dflt !== "string" || !/^\.\/dist\/.+\.js$/.test(dflt)) {
    problems.push(`${key}: default is ${JSON.stringify(dflt)}, not ./dist/*.js`);
  }
  if (typeof sourceTarget === "string" && typeof dflt === "string") {
    const expected = sourceTarget.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
    if (dflt !== expected) problems.push(`${key}: default ${dflt} is not the compiled ${sourceTarget} (${expected})`);
  }
  // Node reads conditions in key order, so `@intentius/chant-source` must come before `default`.
  const keys = Object.keys(entry);
  if (keys.indexOf("@intentius/chant-source") > keys.indexOf("default")) problems.push(`${key}: @intentius/chant-source must come before default`);
  for (const condition of ["import", "require", "node"]) {
    if (condition in entry) problems.push(`${key}: a "${condition}" condition would win over default in Node; leave it out`);
  }
  return problems;
}

describe("lexicon packages ship compiled JS (#3981)", () => {
  test("finds the lexicons", () => {
    expect(LEXICONS.length).toBeGreaterThanOrEqual(20);
  });

  test.each(LEXICONS)("%s: every module export has default on dist/*.js and @intentius/chant-source on src/*.ts", (name) => {
    const { exports } = manifest(name);
    expect(exports["."], "the root export").toBeDefined();
    const problems = Object.entries(exports).flatMap(([key, value]) => exportProblems(key, value));
    expect(problems).toEqual([]);
  });

  test.each(LEXICONS)("%s: the build keeps the emitted JS and the prepack runs it", (name) => {
    const { scripts = {} } = manifest(name);
    expect(scripts.build, "build").toMatch(/\b(tsc|tsc7\.sh) -p tsconfig\.build\.json\b/);
    expect(scripts.build, "build must not delete dist/*.js (#433 did)").not.toMatch(/-delete|\brm\b|\.js\.map/);
    expect(scripts.prepack?.split("&&").map((s) => s.trim()), "prepack").toContain("npm run build");
  });

  test.each(LEXICONS)("%s: tsc compiles src/ to dist/ and the package publishes dist/ only", (name) => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "lexicons", name, "tsconfig.build.json"), "utf-8")) as {
      compilerOptions: { outDir?: string; rootDir?: string; noEmit?: boolean; customConditions?: string[] };
    };
    expect(tsconfig.compilerOptions).toMatchObject({ outDir: "dist", rootDir: "src", noEmit: false });
    // A lexicon importing another compiles against its source, as the repository resolves it.
    expect(tsconfig.compilerOptions.customConditions).toContain("@intentius/chant-source");
    const files = manifest(name).files ?? [];
    expect(files).toContain("dist/");
    expect(files).not.toContain("src/");
    expect(manifest(name).scripts?.build, "build").toContain("copy-lexicon-assets.mjs");
  });
});

describe("exportProblems", () => {
  test("accepts the shape every lexicon uses", () => {
    expect(exportProblems(".", { "@intentius/chant-source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" })).toEqual([]);
    expect(exportProblems("./*", { "@intentius/chant-source": "./src/*.ts", types: "./dist/*.d.ts", default: "./dist/*.js" })).toEqual([]);
    expect(exportProblems("./meta", "./dist/meta.json")).toEqual([]);
    expect(exportProblems("./types", "./dist/types/index.d.ts")).toEqual([]);
  });

  test("refuses a default still on src/*.ts", () => {
    expect(exportProblems(".", { "@intentius/chant-source": "./src/index.ts", default: "./src/index.ts" })).toContain(`.: default is "./src/index.ts", not ./dist/*.js`);
  });

  test("refuses a default that is not the @intentius/chant-source module compiled", () => {
    expect(exportProblems(".", { "@intentius/chant-source": "./src/index.ts", default: "./dist/other.js" })).toEqual([
      ".: default ./dist/other.js is not the compiled ./src/index.ts (./dist/index.js)",
    ]);
  });

  test("refuses a missing @intentius/chant-source, a condition after default, and an import condition", () => {
    expect(exportProblems(".", { default: "./dist/index.js" })).toEqual([".: @intentius/chant-source is undefined, not ./src/*.ts"]);
    expect(exportProblems(".", { default: "./dist/index.js", "@intentius/chant-source": "./src/index.ts" })).toEqual([".: @intentius/chant-source must come before default"]);
    expect(exportProblems(".", { "@intentius/chant-source": "./src/index.ts", import: "./dist/index.js", default: "./dist/index.js" })).toEqual([
      `.: a "import" condition would win over default in Node; leave it out`,
    ]);
  });

  test("refuses a bare module path", () => {
    expect(exportProblems("./x", "./src/x.ts")).toHaveLength(1);
  });
});
