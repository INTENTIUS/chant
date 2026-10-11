/**
 * Importing the lexicon must not pay for schema validation (#2958): ajv
 * loads the first time a schema is checked, and the schemas come from the
 * generated `spec/schemas.gen.ts`, not from files beside the source.
 */

import { describe, expect, test } from "vitest";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SCHEMA_NAMES } from "./pin";
import { loadSchema } from "./spec/schemas";
import { bundledSchema, schemaValidationUnavailable } from "./schema-validate";

const srcDir = dirname(fileURLToPath(import.meta.url));
const tsx = join(srcDir, "..", "..", "..", "node_modules", ".bin", "tsx");

/** How many ajv modules a fresh process has loaded after importing `entries`. */
function ajvModulesAfterImporting(...entries: string[]): number {
  const imports = entries.map((e) => `import(${JSON.stringify(join(srcDir, e))})`).join(", ");
  const script = `Promise.all([${imports}]).then(() => console.log(Object.keys(require.cache).filter((k) => k.includes("/ajv/")).length))`;
  return Number(execFileSync(tsx, ["-e", script], { encoding: "utf-8" }).trim());
}

describe("load cost", () => {
  test("importing the package root, its plugin or the validation subpath does not load ajv", () => {
    // index.ts imports plugin.ts, whose post-synth checks reach schema-validate.ts.
    expect(ajvModulesAfterImporting("index.ts", "validation.ts")).toBe(0);
  });

  test("importing the package root does not load core's Op module (#3026)", () => {
    const script = `import(${JSON.stringify(join(srcDir, "index.ts"))}).then(() => console.log(Object.keys(require.cache).filter((k) => /packages\\/core\\/src\\/op\\//.test(k)).length))`;
    expect(Number(execFileSync(tsx, ["-e", script], { encoding: "utf-8" }).trim())).toBe(0);
  });

  test("validation reads the overlaid schemas from the generated module", () => {
    expect(schemaValidationUnavailable()).toBeUndefined();
    for (const name of SCHEMA_NAMES) expect(bundledSchema(name)).toEqual(loadSchema(name));
  });
});
