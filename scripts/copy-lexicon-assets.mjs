#!/usr/bin/env node
// Run from a lexicon package directory by its `build` script. A lexicon
// publishes dist/ and not src/, so the JSON a compiled module reads beside
// itself (generated/lexicon-<name>.json, vendored schemas, spec snapshots)
// is copied from src/ to the same relative path under dist/. moduleSourceDir
// in @intentius/chant/module-source finds it there when src/ is absent.
// Test data, fixtures and snapshots stay in src/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = process.cwd();
const src = join(root, "src");
const dist = join(root, "dist");
const SKIP_DIRS = new Set(["node_modules", "testdata", "fixtures", "test-fixtures", "__fixtures__", "__snapshots__", "__golden__"]);

if (!existsSync(src)) process.exit(0);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(path);
      continue;
    }
    if (!name.endsWith(".json") || /\.test\./.test(name)) continue;
    const out = join(dist, relative(src, path));
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(path, out);
  }
}

walk(src);
