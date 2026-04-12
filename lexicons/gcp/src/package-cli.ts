#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run bundle` in lexicon-gcp.
 * Generates src/generated/ files and writes dist/ bundle.
 *
 * NOTE: Uses top-level await (matching AWS/Azure pattern) to avoid
 * event loop references from async wrappers keeping the process alive.
 */
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(pkgDir, "..", "dist");

const verbose = process.argv.includes("--verbose") || !process.argv.includes("--quiet");
const force = process.argv.includes("--force");

const { spec, stats } = await packageLexicon({ verbose, force });
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
