import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A package may only import, by name, what it declares.
 *
 * chant-v0.71.0 shipped `packages/core/src/op/activities/apply.ts` doing
 * `await import("js-yaml")` while core's package.json declared no such
 * dependency. Inside this repository it resolved anyway, hoisted out of the six
 * lexicons that do declare it, so every test and every local build passed. A
 * consumer installing `@intentius/chant` alone got an unresolvable import, and
 * the three warden repositories all failed to bundle on the version bump.
 *
 * That is the shape worth gating: a missing dependency is invisible in a
 * workspace and only fails downstream, which is the most expensive place to
 * find it, after a release is already tagged and published. It is the same
 * reasoning as the two guards next door — `peer-deps.test.ts` and
 * `publish-metadata.test.ts` both exist because a packaging field nobody could
 * see locally broke a publish or an install.
 *
 * Scope and precision. This walks the real import nodes with the TypeScript
 * parser rather than matching text, so a specifier inside a comment, a
 * code-generation template string, or this repository's own fold-import
 * fixtures is not mistaken for an import. Only a literal specifier counts: a
 * variable specifier is the codebase's established way of saying "a package
 * this one deliberately does not depend on" (see `loadK8sApplier` in
 * `op/activities/apply.ts`), and nothing statically resolves it.
 */
const CORE = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A package core imports by name on purpose without declaring it, and why.
 *
 * An entry here is a promise that the import is guarded: reaching it without
 * the package installed produces an actionable error rather than a crash.
 * Anything else belongs in `dependencies`.
 */
const DELIBERATELY_UNDECLARED = new Map<string, string>([
  [
    "@cdktf/hcl2json",
    "carries a ~1.8 MB wasm blob and is only needed by `chant carve`; " +
      "`terraform/parse.ts` catches the failed import and prints the install line",
  ],
  [
    "@intentius/chant-lexicon-gitlab",
    "the only lexicon shipping migration rules today; `cli/commands/migrate.ts` " +
      "catches the failed import and migrates with no extra rules. Core depending on " +
      "a lexicon would invert the dependency direction the whole layering rests on",
  ],
]);

/** Every `.ts` file that ships, excluding tests and the fixture trees. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return /__fixtures__|__tests__|[/\\]fixtures$/.test(path) ? [] : sourceFiles(path);
    }
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [path] : [];
  });
}

/** The package name a specifier resolves to: `zod/v4` -> `zod`, `@a/b/c` -> `@a/b`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Literal bare specifiers this file imports, from real import nodes only. */
function importedPackages(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const add = (node: ts.Expression | undefined): void => {
    if (!node || !ts.isStringLiteral(node)) return;
    const specifier = node.text;
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return;
    const name = packageOf(specifier);
    if (builtins.has(name)) return;
    out.add(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal as ts.Expression);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return out;
}

const builtins = new Set(builtinModules);

describe("@intentius/chant imports only what it declares", () => {
  const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  test("every literal bare import is declared, or deliberately not", () => {
    const undeclared = new Map<string, string[]>();
    for (const file of sourceFiles(join(CORE, "src"))) {
      for (const name of importedPackages(file)) {
        if (declared.has(name) || DELIBERATELY_UNDECLARED.has(name)) continue;
        const where = undeclared.get(name) ?? [];
        where.push(relative(CORE, file));
        undeclared.set(name, where);
      }
    }

    expect(
      [...undeclared].map(([name, where]) => `${name} (${where.join(", ")})`),
      "imported by name but absent from package.json. Add it to dependencies, " +
        "or guard the import and record it in DELIBERATELY_UNDECLARED with the reason.",
    ).toEqual([]);
  });

  test("js-yaml specifically, since that is the one that shipped broken", () => {
    // chant-v0.71.0's regression, pinned by name so the fix cannot be reverted
    // quietly: `renderKustomization` parses `kustomize build` output with it.
    expect(declared.has("js-yaml")).toBe(true);
  });

  test("the deliberate exceptions are still imported, so the list cannot rot", () => {
    const imported = new Set(sourceFiles(join(CORE, "src")).flatMap((f) => [...importedPackages(f)]));
    for (const name of DELIBERATELY_UNDECLARED.keys()) {
      expect(imported.has(name), `${name} is listed as deliberately undeclared but nothing imports it`).toBe(true);
    }
  });
});
