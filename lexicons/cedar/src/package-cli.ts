#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run bundle` in lexicon-cedar.
 *
 * Unlike the other lexicons this does not generate `src/generated/` first —
 * codegen is schema-driven and per-project, and lands in #1650. Until then
 * the bundle carries the manifest, rules and integrity over an empty registry.
 */
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(pkgDir, "dist");
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
