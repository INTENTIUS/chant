#!/usr/bin/env bun
/**
 * Thin entry point for `bun run generate` in lexicon-aws.
 */
import { generate, writeGeneratedFiles } from "./generate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const result = await generate({ verbose: true });
// src/codegen/generate-cli.ts → dirname x3 → package root
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
writeGeneratedFiles(result, pkgDir);

console.error(`Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`);
if (result.warnings.length > 0) {
  console.error(`${result.warnings.length} warnings`);
}
