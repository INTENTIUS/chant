#!/usr/bin/env tsx
/**
 * Entry point for `npm run bundle` — generates `src/generated/` and writes the
 * `dist/` bundle.
 *
 * Top-level await rather than an async wrapper, matching the other lexicons:
 * an async main() leaves event-loop references that keep the process alive
 * after the bundle is written.
 */
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { packageLexicon } from "./codegen/package";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(pkgDir, "..", "dist");

const verbose = process.argv.includes("--verbose") || !process.argv.includes("--quiet");
const force = process.argv.includes("--force");

const { spec, stats } = await packageLexicon({ verbose, force });
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
