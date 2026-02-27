#!/usr/bin/env bun
/**
 * CLI entry point for GCP lexicon generation.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generate, writeGeneratedFiles } from "./generate";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
