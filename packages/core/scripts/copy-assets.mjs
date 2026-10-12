#!/usr/bin/env node
// Copies the files chant's compiled modules read next to themselves from src/
// into dist/ (#3878): the JSON schemas and lint presets, the .mjs helpers the
// TypeScript build does not emit, and the conformance suites' runtime
// fixtures (`__fixture__`, `__writer_fixture__`). Test fixtures
// (`__fixtures__`), snapshots and tests stay in src/.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

const RUNTIME_FIXTURES = new Set(["__fixture__", "__writer_fixture__"]);
const SKIP_DIRS = new Set(["__fixtures__", "__snapshots__"]);

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const out = join(dist, relative(src, path));
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (RUNTIME_FIXTURES.has(name)) {
        cpSync(path, out, { recursive: true });
        continue;
      }
      walk(path);
      continue;
    }
    if (/\.test\./.test(name)) continue;
    if (name.endsWith(".json")) copy(path, out);
    // An .mjs with a .ts beside it is a source-only entry (conformance/index.mjs
    // loads index.ts through tsx); the compiled index.js stands in for it.
    else if (name.endsWith(".mjs") && !existsSync(path.replace(/\.mjs$/, ".ts"))) copy(path, out);
  }
}

walk(src);
