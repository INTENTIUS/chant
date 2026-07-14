#!/usr/bin/env node
/**
 * Runtime-dependency audit (#837/#839). For each package under packages/ and
 * lexicons/, find external packages imported at *runtime* (not `import type`) that
 * aren't declared in `dependencies` or `peerDependencies`. Such an import only
 * resolves in the monorepo via hoisting and breaks for a published consumer.
 *
 * Exits non-zero when it finds a real gap, so CI can gate on it. False-positive
 * sources are excluded: node builtins, self-imports, and codegen/template/fixture
 * files that emit `import` statements as string literals.
 *
 *   node scripts/depcheck.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const pkgDirs = [];
for (const base of ["packages", "lexicons"]) {
  for (const d of readdirSync(base)) {
    try {
      if (statSync(join(base, d, "package.json"))) pkgDirs.push(join(base, d));
    } catch {
      /* not a package */
    }
  }
}

// Directories whose .ts files legitimately contain `import` statements as strings
// (docs/scaffold codegen) or are test fixtures — not real imports of this package.
const SKIP_DIR = /(^|[\\/])(codegen|templates?|__fixtures__|__generated__|testdata|test-?data|fixtures)([\\/]|$)/;
const importRe = /^\s*import\s+(?!type\s)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !SKIP_DIR.test(p)) out.push(p);
  }
  return out;
}

function pkgName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

let findings = 0;
for (const dir of pkgDirs.sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (pkg.private) continue; // a private package can't be installed by a consumer
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})]);
  const missing = new Map();
  for (const f of walk(join(dir, "src"))) {
    // Strip template-literal bodies first: scaffolding/docs code (e.g. a plugin's
    // init templates) embeds `import …` statements as strings, not real imports.
    const src = readFileSync(f, "utf8").replace(/`(?:\\.|[^`\\])*`/g, "``");
    for (const m of src.matchAll(importRe)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative
      const name = pkgName(spec);
      if (BUILTINS.has(spec) || BUILTINS.has(name)) continue; // node builtin (+ subpaths)
      if (name === pkg.name) continue; // self-import (codegen/fixture artifact)
      if (declared.has(name)) continue;
      if (!missing.has(name)) missing.set(name, new Set());
      missing.get(name).add(f.replace(dir + "/", ""));
    }
  }
  if (missing.size) {
    findings += missing.size;
    console.log(`\n${pkg.name} (${dir}) — runtime imports not in dependencies/peerDependencies:`);
    for (const [name, files] of [...missing].sort()) console.log(`  ${name}  (${[...files].join(", ")})`);
  }
}

if (findings) {
  console.log(`\n✗ ${findings} undeclared runtime dependency(ies). Declare each in the package's dependencies or peerDependencies.`);
  process.exit(1);
}
console.log("✓ no undeclared runtime dependencies");
