/**
 * #5130 stopped publishing `src/`, but the packages' `exports` still gave a
 * `development` condition a `src/*.ts` target. Vite and vitest add
 * `development` by default outside production, so a project that tested with
 * either resolved chant to files the tarball does not hold. The one condition
 * that may name `src/` is `@intentius/chant-source`, which no tool sets and
 * this repository's own tools ask for.
 *
 * Reads the package.json of every published package under packages/ and
 * lexicons/. A package whose `files` still lists `src/` ships those targets,
 * and is left out.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SOURCE_CONDITION = "@intentius/chant-source";

interface Manifest {
  name: string;
  private?: boolean;
  files?: string[];
  exports?: unknown;
}

function published(): { dir: string; manifest: Manifest }[] {
  const found: { dir: string; manifest: Manifest }[] = [];
  for (const group of ["packages", "lexicons"]) {
    for (const name of readdirSync(join(ROOT, group)).sort()) {
      const file = join(ROOT, group, name, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf-8")) as Manifest;
      if (manifest.private) continue;
      if (manifest.files?.some((f) => /^(\.\/)?src\/?$/.test(f))) continue;
      found.push({ dir: `${group}/${name}`, manifest });
    }
  }
  return found;
}

/**
 * Every `exports` path whose target is under `src/` and that is not reached
 * through the source condition, as `<export key> <conditions...>`.
 */
function srcTargets(exportsField: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (typeof value === "string") {
      if (/^\.\/src\//.test(value) && !path.includes(SOURCE_CONDITION)) out.push(`${path.join(" ")} -> ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, path));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
    }
  };
  walk(exportsField, []);
  return out;
}

describe("published exports never reach src/ through a condition a tool sets", () => {
  const packages = published();

  test("finds core and the lexicons", () => {
    expect(packages.length).toBeGreaterThanOrEqual(24);
    expect(packages.map((p) => p.manifest.name)).toContain("@intentius/chant");
  });

  test.each(packages.map((p) => [p.dir, p.manifest] as const))("%s", (_dir, manifest) => {
    expect(srcTargets(manifest.exports)).toEqual([]);
  });
});

describe("srcTargets", () => {
  test("flags development, default and a bare string on src/", () => {
    expect(srcTargets({ ".": { development: "./src/index.ts", default: "./dist/index.js" } })).toEqual([". development -> ./src/index.ts"]);
    expect(srcTargets({ ".": { default: "./src/index.ts" } })).toEqual([". default -> ./src/index.ts"]);
    expect(srcTargets({ ".": "./src/index.ts" })).toEqual([". -> ./src/index.ts"]);
    expect(srcTargets({ ".": { node: { development: "./src/index.ts" } } })).toEqual([". node development -> ./src/index.ts"]);
  });

  test("allows the source condition and dist/ targets", () => {
    expect(srcTargets({ ".": { [SOURCE_CONDITION]: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" } })).toEqual([]);
    expect(srcTargets({ "./meta": "./dist/meta.json" })).toEqual([]);
  });
});
