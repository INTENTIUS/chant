#!/usr/bin/env tsx
/**
 * Thin entry point for `npm run generate` in lexicon-temporal.
 */
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const result = await generate({ verbose: true });
// src/codegen/generate-cli.ts → dirname x3 → package root
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
writeGeneratedFiles(result, pkgDir);

console.error(`temporal: ${result.resources} resources (hand-written)`);
if (result.warnings.length > 0) {
  console.error(`${result.warnings.length} warnings`);
}
