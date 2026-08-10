#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run bundle` in lexicon-gitlab.
 * Generates src/generated/ files and writes dist/ bundle.
 */
import { generate, writeGeneratedFiles } from "./codegen/generate";
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

// 1. Generate src/generated/ files
const genResult = await generate({ verbose: true });
writeGeneratedFiles(genResult, pkgDir);
console.error(`Generated ${genResult.resources} entities, ${genResult.properties} property types, ${genResult.enums} enums`);

// 2. Run package pipeline and write dist/
const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(pkgDir, "dist");
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
