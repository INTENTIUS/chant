#!/usr/bin/env bun
/**
 * CLI entry point for GCP lexicon generation.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { generate, writeGeneratedFiles } from "./generate";

// src/codegen/generate-cli.ts → dirname x3 → package root
const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const verbose = process.argv.includes("--verbose") || !process.argv.includes("--quiet");
const force = process.argv.includes("--force");

const result = await generate({ verbose, force });
writeGeneratedFiles(result, pkgDir);

console.error(
  `Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`,
);
if (result.warnings.length > 0) {
  console.error(`${result.warnings.length} warnings`);
}
