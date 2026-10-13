#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run bundle` in lexicon-otel.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeBundleSpec } from "@intentius/chant/codegen/package";
import { generate, writeGeneratedFiles } from "./codegen/generate";
import { packageLexicon } from "./codegen/package";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

writeGeneratedFiles(await generate({ verbose: true }));
const { spec, stats } = await packageLexicon({ verbose: true });
writeBundleSpec(spec, join(pkgDir, "dist"));

console.error(`Packaged ${stats.resources} entities, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
