#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run bundle` in lexicon-k3d.
 */
import { generate, writeGeneratedFiles } from "./codegen/generate";
import { packageLexicon } from "./codegen/package";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(fileURLToPath(import.meta.url));

// 1. Generate src/generated/ files (writeGeneratedFiles resolves its own target)
const genResult = await generate({ verbose: true });
writeGeneratedFiles(genResult);

// 2. Run package pipeline and write dist/
const { spec, stats } = await packageLexicon({ verbose: true });

const distDir = join(dirname(pkgDir), "dist");
writeBundleSpec(spec, distDir);

console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
console.error(`dist/ written to ${distDir}`);
