#!/usr/bin/env node
/**
 * Copy runtime asset files (JSON, Markdown, raw .mjs/.mts) from src/ to dist/,
 * preserving directory structure. tsc emits .js/.d.ts but does NOT copy assets
 * that shipped code reads at runtime — e.g. core's lint presets
 * (`lint/presets/*.json`) and each lexicon's generated schema
 * (`generated/lexicon-*.json`) and skill docs (`skills/*.md`).
 *
 * Run per-package (cwd = package dir) after `tsc && tsc-alias`.
 * Test fixtures/snapshots/testdata are intentionally excluded.
 */
import { readdirSync, mkdirSync, copyFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = "src";
const OUT = "dist";

// Directories that hold test-only material — never shipped at runtime.
const SKIP_DIRS = new Set([
  "__fixtures__",
  "__snapshots__",
  "testdata",
  "fixtures",
  "node_modules",
]);

// Asset extensions that shipped runtime code may load.
const ASSET_EXTS = [".json", ".md", ".mjs", ".mts"];

function isAsset(name) {
  if (name.endsWith(".test.json") || name.endsWith(".snap")) return false;
  return ASSET_EXTS.some((ext) => name.endsWith(ext));
}

let copied = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
    } else if (entry.isFile() && isAsset(entry.name)) {
      const dest = join(OUT, full.slice(SRC.length + 1));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(full, dest);
      copied++;
    }
  }
}

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
  console.error(`copy-dist-assets: no ${SRC}/ directory in ${process.cwd()}`);
  process.exit(1);
}
walk(SRC);
console.log(`copy-dist-assets: copied ${copied} asset(s) to ${OUT}/`);
