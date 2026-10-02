/**
 * chant #3088 — which TypeScript runs where.
 *
 * TypeScript 7 does the typechecks and the .d.ts builds, through
 * scripts/tsc7.sh. The `typescript` package stays on 5, because core, the
 * lexicon lint rules and eslint's parser import its JS compiler API, and
 * TypeScript 7's package has none. Both packages ship a `tsc` bin, so an
 * install can swap what `node_modules/.bin/tsc` points at without anything
 * else changing. This fails if any of the three moves.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const major = (version: string) => Number(version.split(".")[0]);

/** The `typescript` version a package at `dir` gets from `import("typescript")`. */
function typescriptFrom(dir: string): string {
  return (createRequire(join(dir, "package.json"))("typescript") as { version: string }).version;
}

/** Every package that declares `typescript` as a dependency of any kind. */
function packagesUsingTypescript(): string[] {
  const dirs: string[] = [];
  for (const parent of ["packages", "lexicons"]) {
    for (const name of readdirSync(join(repoRoot, parent))) {
      const manifest = join(repoRoot, parent, name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf-8")) as Record<string, Record<string, string> | undefined>;
      const declared = ["dependencies", "devDependencies", "peerDependencies"].some((k) => pkg[k]?.typescript);
      if (declared) dirs.push(join(parent, name));
    }
  }
  return dirs;
}

describe("TypeScript versions (#3088)", () => {
  test("scripts/tsc7.sh runs TypeScript 7", () => {
    const out = execFileSync(join(repoRoot, "scripts", "tsc7.sh"), ["-v"], { encoding: "utf-8" });
    expect(out).toMatch(/^Version 7\./);
  });

  test("node_modules/.bin/tsc is the `typescript` package's, not TypeScript 7's", () => {
    const bin = realpathSync(join(repoRoot, "node_modules", ".bin", "tsc"));
    expect(bin).toBe(realpathSync(join(repoRoot, "node_modules", "typescript", "bin", "tsc")));
  });

  test("the root, eslint's parser and every package that declares typescript import TypeScript 5", () => {
    const dirs = packagesUsingTypescript();
    expect(dirs).toContain("packages/core");
    const parser = join(repoRoot, "node_modules", "@typescript-eslint", "parser");
    const versions = Object.fromEntries([".", ...dirs, parser].map((d) => [d, typescriptFrom(resolve(repoRoot, d))]));
    for (const [dir, version] of Object.entries(versions)) {
      expect(major(version), `${dir} imports typescript ${version}`).toBe(5);
    }
  });
});
